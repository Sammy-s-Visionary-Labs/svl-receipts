import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createGeminiReceiptAdapter, GEMINI_RECEIPT_MODEL } from "@svl/integrations";
import { expect, test } from "vitest";

// Opt-in only. Receipt images are synthetic; credentials never enter reports.
const enabled = process.env.RA5_LIVE_GEMINI === "1";
const root = resolve("fixtures/ra5");
const resultsPath = process.env.RA5_GEMINI_RESULTS_FILE
  ? resolve(process.env.RA5_GEMINI_RESULTS_FILE)
  : resolve(root, "evaluation", "gemini-results.json");
type Expected = {
  vendorIncludes: string;
  identifier?: string;
  lines: Array<Record<string, unknown>>;
  warningCodes?: string[];
  [key: string]: unknown;
};
type Fixture = { id: string; images: string[]; cohorts: string[]; expected: Expected };
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
  fixtures: Fixture[];
};
const selection = process.env.RA5_FIXTURE_IDS?.split(",");
const fixtures = manifest.fixtures.filter((f) => !selection || selection.includes(f.id));
const previous = await readFile(resultsPath, "utf8")
  .then((text) => JSON.parse(text).results as Array<{ fixture: string }>)
  .catch(() => []);
const results: unknown[] = previous.filter((row) => !fixtures.some((f) => f.id === row.fixture));

test.skipIf(!enabled).each(fixtures)("Gemini synthetic fixture: $id", async (fixture) => {
  const configured = process.env.RA5_GEMINI_ENV_FILE
    ? parseEnv(await readFile(process.env.RA5_GEMINI_ENV_FILE, "utf8"))
    : {};
  const apiKey = process.env.GEMINI_API_KEY || configured.GEMINI_API_KEY || "";
  const model =
    process.env.GEMINI_EXTRACTION_MODEL ||
    configured.GEMINI_EXTRACTION_MODEL ||
    process.env.GEMINI_MODEL ||
    configured.GEMINI_MODEL ||
    GEMINI_RECEIPT_MODEL;
  if (!apiKey)
    throw new Error("Set GEMINI_API_KEY or RA5_GEMINI_ENV_FILE for the opted-in evaluation.");
  const pages = await Promise.all(
    fixture.images.map(async (name, pageIndex) => ({
      pageIndex,
      mimeType: "image/png" as const,
      bytes: new Uint8Array(await readFile(resolve(root, "images", name))),
    })),
  );
  const started = Date.now();
  const checks: Array<{ field: string; pass: boolean; expected?: unknown; actual?: unknown }> = [];
  const check = (field: string, actual: unknown, expected: unknown) =>
    checks.push({
      field,
      pass: JSON.stringify(actual) === JSON.stringify(expected),
      expected,
      actual,
    });
  let report: Record<string, unknown> = {
    fixture: fixture.id,
    synthetic: true,
    cohorts: fixture.cohorts,
    images: pages.map((page, i) => ({
      name: fixture.images[i],
      sha256: createHash("sha256").update(page.bytes).digest("hex"),
    })),
    requestedModel: model,
  };
  try {
    const result = await createGeminiReceiptAdapter({
      apiKey,
      model,
      timeoutMs: 90_000,
    }).parseReceipt(pages);
    const parsed = result.receipt;
    const wanted = fixture.expected;
    check(
      "vendor",
      parsed.vendor?.toLowerCase().includes(wanted.vendorIncludes.toLowerCase()),
      true,
    );
    if (wanted.identifier)
      check(
        "identifier",
        [parsed.invoice_number, parsed.ticket_number].includes(wanted.identifier),
        true,
      );
    for (const [field, value] of Object.entries(wanted)) {
      if (["vendorIncludes", "identifier", "lines", "warningCodes"].includes(field)) continue;
      check(field, parsed[field as keyof typeof parsed], value);
    }
    check("line_count", parsed.lines.length, wanted.lines.length);
    for (const [index, line] of wanted.lines.entries()) {
      for (const [field, value] of Object.entries(line)) {
        const actual = parsed.lines[index];
        if (field === "jobHintIncludes") {
          check(`lines.${index}.job_hint`, actual?.job_hint?.includes(String(value)), true);
        } else check(`lines.${index}.${field}`, actual?.[field as keyof typeof actual], value);
      }
    }
    for (const code of wanted.warningCodes ?? [])
      check(
        `warning.${code}`,
        parsed.warnings.some((w) => w.code === code),
        true,
      );
    check("has_field_evidence", parsed.evidence.length > 0, true);
    report = {
      ...report,
      actualModel: result.model,
      promptVersion: result.promptVersion,
      schemaVersion: parsed.schema_version,
      usage: result.usage,
      checks,
      warningCodes: [...new Set(parsed.warnings.map((w) => w.code))],
      normalizedPrediction: {
        ...parsed,
        raw_text: undefined,
        evidence: undefined,
        original_observation: undefined,
      },
      passed: checks.every((c) => c.pass),
    };
  } catch (cause) {
    const safe = cause as { code?: string; kind?: string };
    report = {
      ...report,
      passed: false,
      providerError: { code: safe.code ?? "evaluation_failed", kind: safe.kind ?? "unknown" },
    };
  } finally {
    report = { ...report, durationMs: Date.now() - started };
    results.push(report);
    await writeFile(
      resultsPath,
      `${JSON.stringify(
        {
          evaluatedAt: new Date().toISOString(),
          syntheticOnly: true,
          deferred: ["real-vendor accuracy", "live Housecall verification"],
          results,
        },
        null,
        2,
      )}\n`,
    );
  }
  expect(
    report.passed,
    JSON.stringify({
      fixture: fixture.id,
      failedChecks: checks.filter((c) => !c.pass),
      error: report.providerError,
    }),
  ).toBe(true);
});
