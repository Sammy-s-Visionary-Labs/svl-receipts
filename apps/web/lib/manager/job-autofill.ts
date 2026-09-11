import { INTELLIGENCE_SCORING_VERSION, type ReviewDraft } from "@svl/domain";
import type { ManagerJob } from "./review-contract";

export type AutomaticJobAssignment = {
  lineIndex: number;
  jobId: string | null;
  sourceText: string | null;
  message: string;
};
type Hints = {
  job_hints?: Array<{ text: string }>;
  lines?: Array<{ source_index: number; job_hint?: string | null }>;
  confidence?: Record<string, number>;
};
const norm = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const general = (text: string) =>
  /^(shop|stock|inventory|overhead|general materials|business supplies)(\b|$)/.test(norm(text));
const identityCodes = new Set(["exact_reference", "customer_name", "similar_customer"]);

/** Suggestions populate only an untouched draft. Nothing is persisted or exported. */
export function autofillReceiptJobs(draft: ReviewDraft, hints: Hints, suggestions: ManagerJob[]) {
  const assignments: AutomaticJobAssignment[] = [];
  const receiptHints = (hints.job_hints ?? []).map((hint, index) => ({
    text: hint.text,
    confidence: hints.confidence?.[`job_hints.${index}`] ?? 0,
  }));
  const hasLineHints = (hints.lines ?? []).some((line) => !!line.job_hint?.trim());
  const lines = draft.lines.map((line, lineIndex) => {
    if (line.jobId) return { ...line };
    const sourceIndex = line.sourceIndex ?? lineIndex;
    const printed = hints.lines
      ?.find((item) => item.source_index === sourceIndex)
      ?.job_hint?.trim();
    const sources = printed
      ? [{ text: printed, confidence: hints.confidence?.[`lines.${sourceIndex}.job_hint`] ?? 0 }]
      : receiptHints;
    const review = (message: string) => {
      assignments.push({ lineIndex, jobId: null, sourceText: printed ?? null, message });
      return { ...line };
    };
    if (!printed && hasLineHints)
      return review(
        "This receipt has material-specific job names. Choose a destination for this unlabelled line.",
      );
    if (sources.some((hint) => general(hint.text)))
      return review(
        "Shop or general materials need a manager allocation; no customer job was selected.",
      );
    const trusted = new Set(
      sources.filter((hint) => hint.confidence >= 0.8).map((hint) => norm(hint.text)),
    );
    const evidence = (job: ManagerJob) => [
      ...new Set(
        (job.reasons ?? [])
          .filter((reason) => identityCodes.has(reason.code))
          .flatMap((reason) => reason.evidence ?? [])
          .map(norm)
          .filter((text) => trusted.has(text)),
      ),
    ];
    const identityStrength = (job: ManagerJob) =>
      Math.max(
        0,
        ...(job.reasons ?? [])
          .filter((reason) => reason.evidence?.some((text) => trusted.has(norm(text))))
          .map((reason) =>
            reason.code === "exact_reference"
              ? 1000
              : reason.code === "customer_name"
                ? 80
                : reason.code === "similar_customer"
                  ? 40
                  : 0,
          ),
      );
    const candidates = suggestions
      .filter(
        (job) =>
          job.source === "housecall" &&
          !job.unavailable &&
          job.stale === false &&
          job.scoringVersion?.startsWith(`${INTELLIGENCE_SCORING_VERSION}:`) &&
          (printed ? job.sourceIndex === sourceIndex : job.sourceIndex === undefined) &&
          (job.score ?? 0) >= 40 &&
          evidence(job).length > 0,
      )
      .sort(
        (a, b) =>
          identityStrength(b) - identityStrength(a) ||
          (b.score ?? 0) - (a.score ?? 0) ||
          a.id.localeCompare(b.id),
      );
    const best = candidates[0];
    if (!best)
      return review("No clear job match from the receipt text. Select the correct Housecall job.");
    const bestEvidence = new Set(evidence(best));
    if (
      candidates
        .slice(1)
        .some(
          (candidate) =>
            candidate.id !== best.id && evidence(candidate).some((text) => !bestEvidence.has(text)),
        )
    )
      return review(
        "The receipt names more than one possible job. Confirm the destination for this material.",
      );
    const runner = candidates.find((candidate) => candidate.id !== best.id);
    if (
      runner &&
      (identityStrength(best) <= identityStrength(runner) ||
        (best.score ?? 0) - (runner.score ?? 0) < 25)
    )
      return review("Several jobs match this name or reference. Select the correct job.");
    const sourceText = sources
      .filter((hint) => bestEvidence.has(norm(hint.text)))
      .map((hint) => hint.text)
      .join(", ");
    assignments.push({
      lineIndex,
      jobId: best.id,
      sourceText,
      message: `Automatically matched from “${sourceText}”. Verify the job before approval.`,
    });
    return { ...line, jobId: best.id };
  });
  return { draft: { ...draft, lines }, assignments };
}
