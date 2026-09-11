/** Deterministic RA-5 suggestions. Scores are evidence weights, never probabilities. */
export const INTELLIGENCE_SCORING_VERSION = "ra5-rules-v2";
export type IntelligenceReason = { code: string; message: string; evidence?: string[] };
const norm = (value: string | null | undefined) =>
  (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const identifier = (value: string | null | undefined) => norm(value).replaceAll(" ", "");
const presentEqual = (a: string | null | undefined, b: string | null | undefined) =>
  !!identifier(a) && identifier(a) === identifier(b);
export type DuplicateReceipt = {
  id: string;
  accessScope: string;
  deleted?: boolean;
  purging?: boolean;
  pageHashes: string[];
  vendor: string | null;
  purchaseDate: string | null;
  totalCents: number | null;
  invoiceNumber?: string | null;
  ticketNumber?: string | null;
};
export type DuplicateCandidate = {
  receiptId: string;
  score: number;
  reasons: IntelligenceReason[];
  scoringVersion: string;
};
export function scoreDuplicateReceipts(
  receipt: DuplicateReceipt,
  others: DuplicateReceipt[],
  config: { threshold?: number; amountToleranceCents?: number } = {},
): DuplicateCandidate[] {
  const threshold = config.threshold ?? 45;
  const tolerance = config.amountToleranceCents ?? 0;
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 100 ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0
  )
    throw new Error("Invalid duplicate thresholds");
  const scoringVersion = `${INTELLIGENCE_SCORING_VERSION}:d${threshold}:a${tolerance}`;
  if (receipt.deleted || receipt.purging) return [];
  return others
    .filter(
      (other) =>
        other.id !== receipt.id &&
        other.accessScope === receipt.accessScope &&
        !other.deleted &&
        !other.purging,
    )
    .map((other) => {
      const reasons: IntelligenceReason[] = [];
      const add = (code: string, message: string) => reasons.push({ code, message });
      const hashes = (values: string[]) =>
        [...values]
          .map((v) => v.toLowerCase())
          .sort()
          .join("|");
      if (
        receipt.pageHashes.length > 0 &&
        receipt.pageHashes.every(Boolean) &&
        other.pageHashes.every(Boolean) &&
        receipt.pageHashes.length === other.pageHashes.length &&
        hashes(receipt.pageHashes) === hashes(other.pageHashes)
      ) {
        return {
          receiptId: other.id,
          score: 100,
          reasons: [{ code: "exact_image_hash", message: "All receipt image checksums match." }],
          scoringVersion,
        };
      }
      let score = 0;
      const sameVendor = !!norm(receipt.vendor) && norm(receipt.vendor) === norm(other.vendor);
      if (sameVendor) {
        score += 15;
        add("vendor", "Vendor matches.");
      }
      if (receipt.purchaseDate && receipt.purchaseDate === other.purchaseDate) {
        score += 20;
        add("purchase_date", "Purchase date matches.");
      }
      if (
        receipt.totalCents !== null &&
        other.totalCents !== null &&
        Number.isSafeInteger(receipt.totalCents) &&
        Number.isSafeInteger(other.totalCents) &&
        Math.abs(receipt.totalCents - other.totalCents) <= tolerance
      ) {
        score += 15;
        add(
          "total",
          tolerance
            ? "Receipt totals are within the configured tolerance."
            : "Receipt total matches.",
        );
      }
      const sameIdentifier =
        presentEqual(receipt.invoiceNumber, other.invoiceNumber) ||
        presentEqual(receipt.ticketNumber, other.ticketNumber);
      if (sameIdentifier && sameVendor) {
        score += 55;
        add("document_identifier", "Vendor and invoice or ticket number match.");
      }
      const conflict = (a: string | null | undefined, b: string | null | undefined) =>
        !!identifier(a) && !!identifier(b) && !presentEqual(a, b);
      if (
        conflict(receipt.invoiceNumber, other.invoiceNumber) ||
        conflict(receipt.ticketNumber, other.ticketNumber)
      ) {
        score -= 70;
        add(
          "different_identifier",
          "Invoice or ticket identifiers differ; this may be a separate purchase.",
        );
      }
      return {
        receiptId: other.id,
        score: Math.min(99, Math.max(0, score)),
        reasons,
        scoringVersion,
      };
    })
    .filter((candidate) => candidate.score >= threshold && candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.receiptId.localeCompare(b.receiptId));
}
export type JobCatalogEntry = {
  id: string;
  label: string;
  customer?: string | null;
  number?: string | null;
  poReferences?: string[];
  active?: boolean;
  status?: string | null;
  scheduledAt?: string | null;
  assignedWorkerIds?: string[];
  vendorHistory?: string[];
  serviceAddress?: string | null;
  lat?: number | null;
  lng?: number | null;
};
export type JobHint = { text: string; sourceIndex?: number; pageIndex?: number };
export type JobRankingContext = {
  hints: JobHint[];
  sourceIndex?: number;
  purchaseDate?: string | null;
  uploaderId?: string | null;
  vendor?: string | null;
  uploaderJobIds?: string[];
  gps?: { lat: number; lng: number; accuracyMeters: number } | null;
};
export type RankedJobCandidate = {
  housecallJobId: string;
  label: string;
  score: number;
  reasons: IntelligenceReason[];
  scoringVersion: string;
  sourceIndex?: number;
};
const validCoordinates = (lat: unknown, lng: unknown) =>
  typeof lat === "number" &&
  Number.isFinite(lat) &&
  Math.abs(lat) <= 90 &&
  typeof lng === "number" &&
  Number.isFinite(lng) &&
  Math.abs(lng) <= 180;
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const d =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(d), Math.sqrt(1 - d));
}
const words = (v: string) =>
  new Set(
    norm(v)
      .split(" ")
      .filter((word) => word.length > 1),
  );
function nameSimilarity(a: string, b: string) {
  const aa = words(a);
  const bb = words(b);
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter((word) => bb.has(word)).length;
  return intersection / Math.max(aa.size, bb.size);
}
function matchesReference(text: string, reference: string) {
  const target = identifier(reference);
  const tokens = norm(text).split(" ");
  const maxWords = norm(reference).split(" ").length;
  for (let start = 0; start < tokens.length; start++) {
    let window = "";
    for (let width = 0; width < maxWords && start + width < tokens.length; width++) {
      window += tokens[start + width];
      if (window === target) return true;
    }
  }
  return false;
}
/** Only catalog IDs are returned; document text can never mint a job identity. */
export function rankJobCandidates(
  context: JobRankingContext,
  catalog: JobCatalogEntry[],
  config: { maxGpsAccuracyMeters?: number; maxDistanceKm?: number; minScore?: number } = {},
) {
  const maxAccuracy = config.maxGpsAccuracyMeters ?? 100;
  const maxDistance = config.maxDistanceKm ?? 10;
  const minScore = config.minScore ?? 8;
  if (![maxAccuracy, maxDistance, minScore].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("Invalid job scoring configuration");
  const scoringVersion = `${INTELLIGENCE_SCORING_VERSION}:g${maxAccuracy}:k${maxDistance}:m${minScore}`;
  const hasOwnHint =
    context.sourceIndex !== undefined &&
    context.hints.some((h) => h.sourceIndex === context.sourceIndex && norm(h.text));
  const hints = context.hints
    .filter((h) => !hasOwnHint || h.sourceIndex === context.sourceIndex)
    .filter((h) => h.sourceIndex === undefined || h.sourceIndex === context.sourceIndex)
    .filter((h) => norm(h.text));
  const entries = catalog.filter(
    (job, index) => job.id.trim() && catalog.findIndex((v) => v.id === job.id) === index,
  );
  const candidates = entries
    .map((job): RankedJobCandidate => {
      const reasons: IntelligenceReason[] = [];
      let score = 0;
      const references = [job.number, ...(job.poReferences ?? [])].filter(
        (v): v is string => !!v && identifier(v).length >= 2,
      );
      const matched = hints.filter((hint) =>
        references.some((reference) => matchesReference(hint.text, reference)),
      );
      if (matched.length) {
        const lineMatch =
          context.sourceIndex !== undefined &&
          matched.some((hint) => hint.sourceIndex === context.sourceIndex);
        score += lineMatch ? 2000 : 1000;
        reasons.push({
          code: "exact_reference",
          message: lineMatch
            ? "Reference on this material line matches this catalog job."
            : "Printed or handwritten job/PO reference matches this catalog job.",
          evidence: [...new Set(matched.map((hint) => hint.text))],
        });
      }
      const nameHints = hints.filter(
        (hint) =>
          job.customer &&
          (norm(hint.text) === norm(job.customer) ||
            ` ${norm(hint.text)} `.includes(` ${norm(job.customer)} `)),
      );
      if (nameHints.length) {
        score += 80;
        reasons.push({
          code: "customer_name",
          message: "Customer name matches receipt evidence.",
          evidence: [...new Set(nameHints.map((hint) => hint.text))],
        });
      } else if (job.customer) {
        const fuzzyHints = hints.filter(
          (hint) => nameSimilarity(hint.text, job.customer ?? "") >= 0.5,
        );
        if (fuzzyHints.length) {
          score += 40;
          reasons.push({
            code: "similar_customer",
            message: "Part of the customer name matches receipt evidence.",
            evidence: [...new Set(fuzzyHints.map((hint) => hint.text))],
          });
        }
      }
      if (job.active !== false && !/cancel|closed|complete/i.test(job.status ?? "")) {
        score += 2;
        reasons.push({ code: "active_job", message: "Job is active in the saved catalog." });
      }
      if (job.scheduledAt && context.purchaseDate) {
        const days =
          Math.abs(Date.parse(job.scheduledAt) - Date.parse(context.purchaseDate)) / 86400000;
        if (Number.isFinite(days) && days <= 3) {
          score += 6;
          reasons.push({
            code: "schedule",
            message: "Job is scheduled within three days of the purchase.",
          });
        }
      }
      if (context.uploaderId && job.assignedWorkerIds?.includes(context.uploaderId)) {
        score += 7;
        reasons.push({ code: "worker_assignment", message: "Uploader is assigned to this job." });
      }
      if (context.vendor && job.vendorHistory?.some((v) => norm(v) === norm(context.vendor))) {
        score += 4;
        reasons.push({
          code: "vendor_history",
          message: "This vendor was previously used for this job.",
        });
      }
      if (context.uploaderJobIds?.includes(job.id)) {
        score += 3;
        reasons.push({
          code: "uploader_context",
          message: "Uploader recently worked on this job.",
        });
      }
      const gps = context.gps;
      if (
        gps &&
        validCoordinates(gps.lat, gps.lng) &&
        Number.isFinite(gps.accuracyMeters) &&
        gps.accuracyMeters >= 0 &&
        gps.accuracyMeters <= maxAccuracy &&
        job.serviceAddress?.trim() &&
        validCoordinates(job.lat, job.lng)
      ) {
        const distance = distanceKm(gps, { lat: job.lat as number, lng: job.lng as number });
        if (distance <= maxDistance) {
          score += 5;
          reasons.push({
            code: "near_service_address",
            message: `Capture was within ${maxDistance} km of the valid service address.`,
          });
        }
      }
      return {
        housecallJobId: job.id,
        label: job.label,
        score,
        reasons,
        scoringVersion,
        ...(context.sourceIndex === undefined ? {} : { sourceIndex: context.sourceIndex }),
      };
    })
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score || a.housecallJobId.localeCompare(b.housecallJobId))
    .slice(0, 5);
  return {
    topCandidate: candidates[0] ?? null,
    candidates,
    scoringVersion,
  };
}
export type ReceiptCategory = {
  id: string;
  label: string;
  active: boolean;
  keywords: string[];
  version: number;
};
export type CategorySuggestion = {
  categoryId: string | null;
  confidence: number;
  reasons: IntelligenceReason[];
  scoringVersion: string;
};
export function suggestReceiptCategory(
  text: string,
  categories: ReceiptCategory[],
  hintedCategoryId?: string | null,
): CategorySuggestion {
  const normalized = ` ${norm(text)} `;
  const scored = categories
    .filter((category) => category.active)
    .map((category) => {
      const matches = [
        ...new Set(
          category.keywords.map(norm).filter((word) => !!word && normalized.includes(` ${word} `)),
        ),
      ];
      return {
        category,
        matches,
        score: matches.length + (hintedCategoryId === category.id ? 1 : 0),
      };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score || a.category.id.localeCompare(b.category.id));
  const best = scored[0];
  if (!best || best.score === scored[1]?.score)
    return {
      categoryId: null,
      confidence: 0,
      reasons: [
        {
          code: "category_review",
          message: "No unique active category match; manager selection is required.",
        },
      ],
      scoringVersion: INTELLIGENCE_SCORING_VERSION,
    };
  return {
    categoryId: best.category.id,
    confidence: best.matches.length ? Math.min(0.95, 0.6 + best.matches.length * 0.1) : 0.5,
    reasons: [
      {
        code: "category_keywords",
        message: `Matches active category ${best.category.label} (configuration ${best.category.version}).`,
        evidence: best.matches,
      },
    ],
    scoringVersion: `${INTELLIGENCE_SCORING_VERSION}:category${best.category.version}`,
  };
}
export type IntelligenceFeedbackRecord = {
  review_id?: string;
  review?: { decision?: string; version?: number | null } | null;
  receipt_id: string;
  actor_id: string;
  field_path: string;
  suggested_value: unknown;
  final_value: unknown;
  accepted: boolean;
  model?: string | null;
  scoring_version?: string | null;
  prompt_version?: string | null;
};
/** Export is an explicit allowlist: free text and identities become stable caller-supplied tokens. */
export function sanitizeFeedbackRecords(
  records: IntelligenceFeedbackRecord[],
  tokenize: (value: string) => string,
) {
  const validPath =
    /^(vendor|purchaseDate|invoiceNumber|ticketNumber|category|referenceTotal|lines\.\d{1,2}\.(description|qty|uom|unitCost|jobId))$/;
  const numericPath = /^(referenceTotal|lines\.\d{1,2}\.(qty|unitCost))$/;
  const safeVersion = (v: string | null | undefined) =>
    v && /^[a-zA-Z0-9._:/-]{1,120}$/.test(v) ? v : null;
  return records
    .filter((row) => validPath.test(row.field_path))
    .map((row) => {
      const sanitize = (value: unknown) => {
        if (value === null || value === undefined || value === "") return null;
        if (
          numericPath.test(row.field_path) &&
          (typeof value === "number" || typeof value === "string") &&
          /^\d{1,12}(\.\d{1,3})?$/.test(String(value))
        )
          return String(value);
        return typeof value === "string" || typeof value === "number"
          ? tokenize(`${row.field_path}:${value}`)
          : "[redacted]";
      };
      return {
        receipt: tokenize(`receipt:${row.receipt_id}`),
        review: row.review_id ? tokenize(`review:${row.review_id}`) : null,
        decision:
          row.review?.decision &&
          ["save_draft", "request_clarification", "decline", "mark_duplicate", "approve"].includes(
            row.review.decision,
          )
            ? row.review.decision
            : null,
        reviewVersion: Number.isSafeInteger(row.review?.version) ? row.review?.version : null,
        actor: tokenize(`actor:${row.actor_id}`),
        field: row.field_path,
        suggested: sanitize(row.suggested_value),
        final: sanitize(row.final_value),
        accepted: row.accepted === true,
        model: safeVersion(row.model),
        scoringVersion: safeVersion(row.scoring_version),
        promptVersion: safeVersion(row.prompt_version),
      };
    });
}
