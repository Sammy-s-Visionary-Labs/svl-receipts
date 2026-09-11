import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createGeminiReceiptAdapter, GEMINI_RECEIPT_MODEL } from "@svl/integrations";
import { expect, test, vi } from "vitest";
import { normalizeExtractionPage } from "../apps/web/lib/work/extraction";

// Use the app's actual image normalization and model adapter; database/storage
// functions cannot run in this synthetic-only evaluation.
vi.mock("../apps/web/lib/storage/receipts", () => ({ readReceiptObject: vi.fn() }));
vi.mock("../apps/web/lib/manager/intelligence", () => ({ buildReceiptIntelligence: vi.fn() }));

type Fixture = {
  id: string;
  documentKey: string;
  syntheticVendor: string;
  purchaseDate: string;
  referenceTaxCents: number;
  referenceReceiptTotalCents: number;
  lines: Array<{
    description: string;
    qty: number;
    uom: string;
    unitCostCents: number;
    extendedCostCents: number;
    jobHint: string | null;
    pageIndex?: number;
  }>;
  expected: { materialTotalCents: number };
};
const root = resolve("fixtures/ra6");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
  receipts: Fixture[];
  documentVariants: Array<{
    id: string;
    baseReceiptId: string;
    documentKey: string;
    purchaseDate?: string;
  }>;
};
const assets = (
  JSON.parse(await readFile(resolve(root, "generated-images.json"), "utf8")) as {
    assets: Array<{ caseId: string; path: string; pageIndex: number; sha256: string }>;
  }
).assets;
const fixtures = [
  ...manifest.receipts,
  ...manifest.documentVariants.map((variant) => {
    const base = manifest.receipts.find((receipt) => receipt.id === variant.baseReceiptId);
    if (!base) throw new Error(`Missing base fixture: ${variant.baseReceiptId}`);
    return { ...base, ...variant, purchaseDate: variant.purchaseDate || base.purchaseDate };
  }),
];
const selected = process.env.RA6_FIXTURE_IDS?.split(",");
const cases = fixtures.filter((fixture) => !selected || selected.includes(fixture.id));
const enabled = process.env.RA6_LIVE_GEMINI === "1";
const resultPath = resolve(root, "evaluation/gemini-results.json");
const previous = await readFile(resultPath, "utf8")
  .then((value) => JSON.parse(value).results as Array<{ fixture: string }>)
  .catch(() => []);
const reports: unknown[] = previous.filter(
  (row) => !cases.some((fixture) => fixture.id === row.fixture),
);

test.skipIf(!enabled).each(cases)("app extraction of synthetic fixture: $id", async (fixture) => {
  const env = parseEnv(await readFile(process.env.RA6_ENV_FILE || "apps/web/.env.local", "utf8"));
  const model = env.GEMINI_EXTRACTION_MODEL || GEMINI_RECEIPT_MODEL;
  const fixtureAssets = assets
    .filter((asset) => asset.caseId === fixture.id)
    .sort((a, b) => a.pageIndex - b.pageIndex);
  const imageEvidence: unknown[] = [];
  const pages = await Promise.all(
    fixtureAssets.map(async (asset) => {
      const original = await readFile(resolve(root, asset.path));
      expect(createHash("sha256").update(original).digest("hex")).toBe(asset.sha256);
      const bytes = await normalizeExtractionPage(original);
      imageEvidence.push({
        path: asset.path,
        pageIndex: asset.pageIndex,
        sha256: asset.sha256,
        normalizedSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return { pageIndex: asset.pageIndex, mimeType: "image/jpeg" as const, bytes };
    }),
  );
  expect(pages.length).toBeGreaterThan(0);
  const checks: Array<{ field: string; pass: boolean; actual: unknown; expected: unknown }> = [];
  const check = (field: string, actual: unknown, expected: unknown) =>
    checks.push({
      field,
      pass: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    });
  const startedAt = new Date().toISOString();
  let report: Record<string, unknown> = {
    fixture: fixture.id,
    startedAt,
    requestedModel: model,
    images: imageEvidence,
    synthetic: true,
  };
  try {
    const result = await createGeminiReceiptAdapter({
      apiKey: env.GEMINI_API_KEY || "",
      model,
      timeoutMs: 90_000,
      fetch: async (input, init) => {
        // No Housecall, storage or database traffic can escape this evaluator.
        if (new URL(String(input)).origin !== "https://generativelanguage.googleapis.com")
          throw new Error("unexpected_provider_origin");
        const response = await fetch(input, { ...init, redirect: "error" });
        if (process.env.RA6_CAPTURE_MODEL_RESPONSE === "1") {
          await mkdir(resolve(".local/ra6/model-diagnostics"), { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(".local/ra6/model-diagnostics", `${fixture.id}.json`),
            await response.clone().text(),
            { mode: 0o600 },
          );
        }
        return response;
      },
    }).parseReceipt(pages);
    const parsed = result.receipt;
    check("vendor", parsed.vendor, fixture.syntheticVendor);
    check(
      "identifier",
      [parsed.invoice_number, parsed.ticket_number].includes(fixture.documentKey),
      true,
    );
    check(
      "date_correct_or_explicitly_unresolved",
      parsed.purchase_date === fixture.purchaseDate ||
        (parsed.purchase_date === null &&
          parsed.warnings.some(
            (warning) => warning.field === "purchase_date" && warning.code === "ambiguous_date",
          )),
      true,
    );
    check("currency", parsed.currency, "USD");
    check("receipt_total_cents", parsed.receipt_total_cents, fixture.referenceReceiptTotalCents);
    check("tax_cents", parsed.tax_cents, fixture.referenceTaxCents);
    check("material_total_cents", parsed.material_total_cents, fixture.expected.materialTotalCents);
    check("line_count", parsed.lines.length, fixture.lines.length);
    for (const [index, expected] of fixture.lines.entries()) {
      const actual = parsed.lines[index];
      check(`lines.${index}.qty`, actual?.qty, expected.qty);
      check(`lines.${index}.unit_cost_cents`, actual?.unit_cost_cents, expected.unitCostCents);
      check(
        `lines.${index}.extended_cost_cents`,
        actual?.extended_cost_cents,
        expected.extendedCostCents,
      );
      check(`lines.${index}.page_index`, actual?.page_index, expected.pageIndex ?? 0);
      // The app combines document-level hints with line-specific hints. A
      // one-line receipt's header reference need not be repeated on its line.
      const observedHint =
        actual?.job_hint ??
        (fixture.lines.length === 1 && parsed.job_hints.length === 1
          ? parsed.job_hints[0].text
          : null);
      check(`lines.${index}.job_hint`, observedHint, expected.jobHint);
      check(
        `lines.${index}.description`,
        actual?.description?.toLowerCase(),
        expected.description.toLowerCase(),
      );
    }
    check("has_field_evidence", parsed.evidence.length > 0, true);
    report = {
      ...report,
      actualModel: result.model,
      promptVersion: result.promptVersion,
      usage: result.usage,
      checks,
      passed: checks.every((row) => row.pass),
      normalizedPrediction: {
        ...parsed,
        raw_text: undefined,
        evidence: undefined,
        original_observation: undefined,
      },
    };
  } catch (cause) {
    const safe = cause as { code?: string; kind?: string };
    report = {
      ...report,
      passed: false,
      providerError: { code: safe.code || "evaluation_failed", kind: safe.kind || "unknown" },
    };
  } finally {
    reports.push({ ...report, completedAt: new Date().toISOString() });
    await mkdir(resolve(root, "evaluation"), { recursive: true });
    await writeFile(
      resultPath,
      `${JSON.stringify({ evaluatedAt: new Date().toISOString(), syntheticOnly: true, scope: "Actual app image normalization and Gemini extraction; database persistence, browser review and live Housecall writes remain separate acceptance steps", results: reports }, null, 2)}\n`,
    );
  }
  expect(
    report.passed,
    JSON.stringify({
      fixture: fixture.id,
      failedChecks: checks.filter((row) => !row.pass),
      providerError: report.providerError,
    }),
  ).toBe(true);
});
