import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type DuplicateReceipt,
  type JobCatalogEntry,
  type ParsedReceiptV1,
  type ReceiptCategory,
  rankJobCandidates,
  scoreDuplicateReceipts,
  suggestReceiptCategory,
} from "@svl/domain";
import { expect, test } from "vitest";

const root = resolve("fixtures/ra5");
const readJson = async (name: string) => JSON.parse(await readFile(resolve(root, name), "utf8"));
const manifest = await readJson("manifest.json");
const catalog = (await readJson("catalog.json")) as {
  jobs: JobCatalogEntry[];
  categories: ReceiptCategory[];
};
const report = await readJson("evaluation/gemini-results.json");
type Prediction = {
  fixture: string;
  passed: boolean;
  images: Array<{ name: string; sha256: string }>;
  normalizedPrediction: ParsedReceiptV1;
};
const predictions = report.results as Prediction[];
const prediction = (id: string) => {
  const value = predictions.find((row) => row.fixture === id);
  if (!value?.passed) throw new Error(`No passing retained Gemini result for ${id}`);
  return value;
};

test("retained Gemini evaluations correspond to the exact visually reviewed fixture images", async () => {
  expect(manifest.synthetic).toBe(true);
  const exactSource = await readFile(resolve(root, manifest.exactDuplicate.source));
  const exactCopy = await readFile(resolve(root, manifest.exactDuplicate.copy));
  expect(exactCopy.equals(exactSource)).toBe(true);
  for (const fixture of manifest.fixtures) {
    const result = prediction(fixture.id);
    for (const page of result.images) {
      const bytes = await readFile(resolve(root, "images", page.name));
      expect(createHash("sha256").update(bytes).digest("hex"), `${fixture.id}/${page.name}`).toBe(
        page.sha256,
      );
    }
  }
});

test("real synthetic-image predictions rank the intended controlled catalog ID for each line", () => {
  for (const fixture of manifest.fixtures) {
    const receipt = prediction(fixture.id).normalizedPrediction;
    const hints = [
      ...receipt.job_hints.map((hint) => ({ text: hint.text, pageIndex: hint.page_index })),
      ...receipt.lines
        .filter((line) => line.job_hint)
        .map((line) => ({
          text: line.job_hint ?? "",
          sourceIndex: line.source_index,
          pageIndex: line.page_index,
        })),
    ];
    const expected = fixture.jobs as string[];
    for (const line of receipt.lines) {
      const ranked = rankJobCandidates(
        { hints, sourceIndex: line.source_index, purchaseDate: receipt.purchase_date },
        catalog.jobs,
      );
      if (!expected.length) expect(ranked.topCandidate, fixture.id).toBeNull();
      else
        expect(ranked.topCandidate?.housecallJobId, `${fixture.id}/${line.source_index}`).toBe(
          expected.length === 1 ? expected[0] : expected[line.source_index],
        );
      expect(ranked.candidates.length).toBeLessThanOrEqual(5);
    }
  }
});

test("category suggestions consume extracted text and the test-only active catalog", () => {
  for (const id of [
    "select-multijob",
    "sandman-decimal-mismatch",
    "perrysburg-multipage",
    "menards-purchase",
    "home-depot-base",
    "fuel-category",
    "klumm-disposal",
  ]) {
    const receipt = prediction(id).normalizedPrediction;
    const result = suggestReceiptCategory(
      [receipt.vendor, ...receipt.lines.map((line) => line.description)].join(" "),
      catalog.categories,
    );
    expect(result.categoryId, id).toBe(
      id === "fuel-category" ? "fuel" : id === "klumm-disposal" ? "dump" : "materials",
    );
  }
});

function duplicateInput(id: string): DuplicateReceipt {
  const result = prediction(id);
  const parsed = result.normalizedPrediction;
  return {
    id,
    accessScope: "ra5-test-owner",
    pageHashes: result.images.map((image) => image.sha256),
    vendor: parsed.vendor,
    purchaseDate: parsed.purchase_date,
    totalCents: parsed.receipt_total_cents,
    invoiceNumber: parsed.invoice_number,
    ticketNumber: parsed.ticket_number,
  };
}

test("rephotographed duplicates match while another purchase with the same products and total does not", () => {
  const original = duplicateInput("home-depot-base");
  const repeated = duplicateInput("home-depot-rephotographed");
  const separate = duplicateInput("home-depot-separate-purchase");
  expect(repeated.pageHashes).not.toEqual(original.pageHashes);
  expect(
    scoreDuplicateReceipts(original, [repeated, separate]).map((row) => row.receiptId),
  ).toEqual([repeated.id]);
  const exact = { ...original, id: "home-depot-exact-copy" };
  expect(scoreDuplicateReceipts(original, [exact])[0]?.score).toBe(100);
});
