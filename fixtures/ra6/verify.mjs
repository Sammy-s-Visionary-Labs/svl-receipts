import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("./manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const bindings = JSON.parse(
  await readFile(new URL("./live-bindings.template.json", import.meta.url), "utf8"),
);

function checkEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

function quantityThousandths(value) {
  const text = String(value);
  assert.match(text, /^\d+(?:\.\d{1,3})?$/);
  const [whole, decimal = ""] = text.split(".");
  const units = BigInt(whole) * 1000n + BigInt(decimal.padEnd(3, "0"));
  assert.ok(units > 0n);
  return units;
}

assert.equal(manifest.synthetic, true);
assert.equal(manifest.kind, "offline-export-contract-fixtures");
assert.equal(manifest.liveWritesApproved, false);
assert.equal(bindings.templateOnly, true);
assert.equal(bindings.liveWritesApproved, false);
assert.equal(bindings.approvedRunReference, null);

const destinationKeys = new Set(manifest.destinations.map((destination) => destination.key));
assert.equal(destinationKeys.size, manifest.destinations.length);
for (const destination of manifest.destinations) {
  assert.equal(destination.housecallJobId, null);
  assert.match(destination.label, /^RA6 Test Customer [234]$/);
}
checkEqual(
  bindings.bindings.map((binding) => binding.destinationKey).sort(),
  [...destinationKeys].sort(),
  "binding template must cover exactly the planned customer destinations",
);
for (const binding of bindings.bindings) {
  assert.equal(binding.housecallJobId, null);
  assert.equal(
    binding.expectedLabel,
    manifest.destinations.find((destination) => destination.key === binding.destinationKey).label,
  );
}

const receiptIds = new Set();
for (const receipt of manifest.receipts) {
  assert.ok(!receiptIds.has(receipt.id), `duplicate receipt id ${receipt.id}`);
  receiptIds.add(receipt.id);
  assert.match(receipt.documentKey, /^RA6-SYN-/);
  assert.match(receipt.syntheticVendor, /^RA6 Test /);
  assert.ok(receipt.pageCount >= 1 && receipt.pageCount <= 5);
  const lineKeys = new Set();
  const totals = {};
  const counts = {};
  const blockedReasons = new Set();
  let materialTotal = 0;
  let unresolvedTotal = 0;
  for (const line of receipt.lines) {
    assert.ok(!lineKeys.has(line.lineKey), `${receipt.id}: repeated line key`);
    lineKeys.add(line.lineKey);
    assert.match(line.description, /^SYNTHETIC TEST /);
    assert.ok(Number.isSafeInteger(line.unitCostCents) && line.unitCostCents >= 0);
    const calculated = Number(
      (quantityThousandths(line.qty) * BigInt(line.unitCostCents) + 500n) / 1000n,
    );
    checkEqual(calculated, line.extendedCostCents, `${receipt.id}/${line.lineKey}: arithmetic`);
    assert.ok(calculated <= 2147483647);
    const pageIndex = line.pageIndex ?? 0;
    assert.ok(Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < receipt.pageCount);
    materialTotal += calculated;
    if (line.destinationKey === null) {
      assert.equal(typeof line.unresolvedReason, "string");
      unresolvedTotal += calculated;
      blockedReasons.add(line.unresolvedReason);
    } else {
      assert.ok(destinationKeys.has(line.destinationKey), `${receipt.id}: unknown destination`);
      totals[line.destinationKey] = (totals[line.destinationKey] ?? 0) + calculated;
      counts[line.destinationKey] = (counts[line.destinationKey] ?? 0) + 1;
    }
  }
  const expected = receipt.expected;
  checkEqual(materialTotal, expected.materialTotalCents, `${receipt.id}: material total`);
  checkEqual(
    unresolvedTotal,
    expected.unresolvedMaterialTotalCents,
    `${receipt.id}: unresolved total`,
  );
  checkEqual(
    materialTotal - unresolvedTotal,
    expected.assignedMaterialTotalCents,
    `${receipt.id}: assigned total`,
  );
  checkEqual(totals, expected.destinationMaterialTotalsCents, `${receipt.id}: job amounts`);
  checkEqual(counts, expected.materialLineCountsByDestination, `${receipt.id}: job line counts`);
  checkEqual(
    [...blockedReasons].sort(),
    [...expected.blockedReasons].sort(),
    `${receipt.id}: blockers`,
  );
  checkEqual(expected.approvalAllowed, blockedReasons.size === 0, `${receipt.id}: approval gate`);
  checkEqual(expected.taxIncludedInMaterialCosts, false, `${receipt.id}: tax policy`);
  checkEqual(
    materialTotal + receipt.referenceTaxCents,
    receipt.referenceReceiptTotalCents,
    `${receipt.id}: synthetic receipt reference arithmetic`,
  );
  const expectedPages = {};
  if (expected.approvalAllowed) {
    for (const key of Object.keys(totals)) {
      expectedPages[key] = Array.from({ length: receipt.pageCount }, (_, index) => index);
    }
  } else {
    checkEqual(expected.expectedExportIntentCount, 0, `${receipt.id}: no blocked intent`);
    checkEqual(expected.expectedProviderWriteCount, 0, `${receipt.id}: no blocked writes`);
  }
  checkEqual(
    expected.requiredPageIndexesByDestination,
    expectedPages,
    `${receipt.id}: all pages at every approved destination`,
  );
}

const variantIds = new Set();
for (const variant of manifest.documentVariants) {
  assert.ok(!variantIds.has(variant.id));
  variantIds.add(variant.id);
  const base = manifest.receipts.find((receipt) => receipt.id === variant.baseReceiptId);
  assert.ok(base, `missing variant base ${variant.baseReceiptId}`);
  if (variant.expectedDuplicateCandidate) {
    checkEqual(variant.documentKey, base.documentKey, "duplicate retains document identity");
    checkEqual(
      variant.expectedNewMaterialWritesAfterConfirmedDuplicate,
      0,
      "duplicate creates no costs",
    );
  } else {
    assert.notEqual(variant.documentKey, base.documentKey);
    assert.notEqual(variant.purchaseDate, base.purchaseDate);
    checkEqual(variant.expectedMaterialTotalCents, base.expected.materialTotalCents);
  }
}

let imageCount = 0;
for (const control of manifest.existingImageControls) {
  const reference = JSON.parse(
    await readFile(new URL(control.expectedFieldsManifest, manifestUrl), "utf8"),
  );
  assert.equal(reference.synthetic, true);
  assert.ok(reference.fixtures.some((fixture) => fixture.id === control.fixtureId));
  for (const imagePath of control.paths) {
    const bytes = await readFile(new URL(imagePath, manifestUrl));
    assert.ok(bytes.length > 0, `missing image bytes ${imagePath}`);
    imageCount += 1;
  }
}
const baseImage = await readFile(new URL("../ra5/images/home-depot-base.png", manifestUrl));
const exactCopy = await readFile(new URL("../ra5/images/home-depot-exact-copy.png", manifestUrl));
const rephotographed = await readFile(
  new URL("../ra5/images/home-depot-rephotographed.png", manifestUrl),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
checkEqual(
  hash(baseImage),
  hash(exactCopy),
  "existing exact-copy control must retain identical bytes",
);
assert.notEqual(
  hash(baseImage),
  hash(rephotographed),
  "existing photo variant must have different bytes",
);

const scenarioIds = new Set();
for (const scenario of manifest.exportScenarios) {
  assert.ok(!scenarioIds.has(scenario.id), `duplicate scenario ${scenario.id}`);
  scenarioIds.add(scenario.id);
  assert.ok(receiptIds.has(scenario.fixtureId));
  assert.ok(scenario.setup.length > 0 && scenario.expected.length > 0);
}

const generatedCatalog = JSON.parse(
  await readFile(new URL("./generated-images.json", manifestUrl), "utf8"),
);
assert.equal(generatedCatalog.synthetic, true);
assert.equal(generatedCatalog.expectedFieldsManifest, "manifest.json");
const generatedIds = new Set();
const generatedPaths = new Set();
let generatedCount = 0;
let reviewedCount = 0;
for (const asset of generatedCatalog.assets) {
  assert.ok(!generatedIds.has(asset.id), `duplicate generated-image ID ${asset.id}`);
  assert.ok(!generatedPaths.has(asset.path), `duplicate generated-image path ${asset.path}`);
  generatedIds.add(asset.id);
  generatedPaths.add(asset.path);
  assert.match(asset.path, /^images\/[a-z0-9-]+\.png$/);
  const receipt = manifest.receipts.find((item) => item.id === asset.caseId);
  const variant = manifest.documentVariants.find((item) => item.id === asset.caseId);
  assert.ok(receipt || variant, `unknown image case ${asset.caseId}`);
  const base = receipt ?? manifest.receipts.find((item) => item.id === variant.baseReceiptId);
  assert.equal(asset.documentKey, (variant ?? receipt).documentKey);
  assert.ok(
    Number.isInteger(asset.pageIndex) && asset.pageIndex >= 0 && asset.pageIndex < base.pageCount,
  );
  assert.ok(["planned", "generated"].includes(asset.status));
  assert.ok(["not-reviewed", "accepted", "rejected"].includes(asset.visualReview.status));
  assert.ok(["not-run", "passed", "failed"].includes(asset.extractionEvaluation.status));
  if (asset.extractionEvaluation.status === "not-run")
    assert.equal(asset.extractionEvaluation.evidencePath, null);
  else {
    assert.equal(asset.status, "generated");
    assert.equal(typeof asset.extractionEvaluation.evidencePath, "string");
    await readFile(new URL(asset.extractionEvaluation.evidencePath, manifestUrl));
  }
  if (asset.status === "planned") {
    for (const field of ["sha256", "byteSize", "width", "height", "provenance"])
      assert.equal(asset[field], null, `planned asset has invented ${field}: ${asset.id}`);
    assert.equal(asset.visualReview.status, "not-reviewed");
    assert.equal(asset.visualReview.checkedAgainstManifest, false);
    assert.equal(asset.extractionEvaluation.status, "not-run");
    continue;
  }
  generatedCount++;
  const bytes = await readFile(new URL(asset.path, manifestUrl));
  assert.equal(
    bytes.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${asset.id}: PNG signature`,
  );
  assert.equal(hash(bytes), asset.sha256, `${asset.id}: generated byte hash`);
  assert.equal(bytes.length, asset.byteSize, `${asset.id}: generated byte length`);
  assert.equal(bytes.readUInt32BE(16), asset.width, `${asset.id}: PNG width`);
  assert.equal(bytes.readUInt32BE(20), asset.height, `${asset.id}: PNG height`);
  const provenance = asset.provenance;
  assert.ok(
    provenance && Number.isFinite(Date.parse(provenance.recordedAt)),
    `${asset.id}: missing actual provenance`,
  );
  assert.equal(provenance.method, asset.plannedMethod);
  if (provenance.method === "imagegen") {
    assert.equal(provenance.tool, "image_gen.imagegen");
    assert.equal(typeof provenance.prompt, "string");
    assert.ok(provenance.prompt.length > 0);
    assert.equal(hash(Buffer.from(provenance.prompt, "utf8")), provenance.promptSha256);
    assert.equal(typeof provenance.toolOutputPath, "string");
    assert.ok(provenance.toolOutputPath.length > 0);
    if (provenance.promptFile)
      assert.equal(
        await readFile(new URL(provenance.promptFile, manifestUrl), "utf8"),
        provenance.prompt,
        `${asset.id}: saved prompt differs from provenance`,
      );
    for (const intermediate of provenance.intermediateOutputs ?? []) {
      assert.equal(intermediate.tool, "image_gen.imagegen");
      assert.match(intermediate.sha256, /^[a-f0-9]{64}$/);
      assert.equal(hash(Buffer.from(intermediate.prompt, "utf8")), intermediate.promptSha256);
      assert.equal(
        await readFile(new URL(intermediate.promptFile, manifestUrl), "utf8"),
        intermediate.prompt,
      );
      assert.equal(intermediate.reviewStatus, "rejected");
      assert.ok(intermediate.notes.length > 0);
      assert.ok(provenance.referencedImagePaths.includes(intermediate.toolOutputPath));
    }
  } else {
    assert.equal(provenance.method, "byte-copy");
    assert.equal(provenance.tool, "filesystem.copy");
    for (const field of ["prompt", "promptSha256", "toolOutputPath"])
      assert.equal(provenance[field], null);
    const source = generatedCatalog.assets.find((item) => item.id === asset.sourceAssetId);
    assert.ok(source && source.status === "generated");
    assert.equal(asset.sha256, source.sha256, `${asset.id}: exact copy differs from its source`);
  }
  if (asset.visualReview.status !== "not-reviewed") {
    assert.equal(typeof asset.visualReview.reviewedBy, "string");
    assert.ok(asset.visualReview.reviewedBy.length > 0);
    assert.ok(Number.isFinite(Date.parse(asset.visualReview.reviewedAt)));
    assert.equal(asset.visualReview.checkedAgainstManifest, true);
    if (asset.visualReview.status === "accepted") reviewedCount++;
    else assert.ok(asset.visualReview.notes.length > 0, "rejection must state the discrepancy");
  }
}
for (const receipt of manifest.receipts) {
  const assets = generatedCatalog.assets.filter((asset) => asset.caseId === receipt.id);
  checkEqual(
    assets.map((asset) => asset.pageIndex).sort(),
    Array.from({ length: receipt.pageCount }, (_, index) => index),
    `${receipt.id}: planned image page coverage`,
  );
}
for (const variant of manifest.documentVariants)
  assert.ok(
    generatedCatalog.assets.some((asset) => asset.caseId === variant.id),
    `${variant.id}: missing planned image`,
  );
const generatedBase = generatedCatalog.assets.find(
  (asset) => asset.id === "select-fractional-base",
);
const generatedRephoto = generatedCatalog.assets.find(
  (asset) => asset.id === "select-fractional-rephotographed",
);
if (generatedBase?.status === "generated" && generatedRephoto?.status === "generated")
  assert.notEqual(
    generatedBase.sha256,
    generatedRephoto.sha256,
    "generated rephotograph must have different pixels",
  );

console.log(
  `RA-6 fixture consistency passed: ${receiptIds.size} receipt cases, ${variantIds.size} document variants, ${scenarioIds.size} expected export scenarios, ${imageCount} existing image references. RA-6 images: ${generatedCount}/${generatedCatalog.assets.length} generated, ${reviewedCount} visually accepted. No network/provider calls; integration outcomes are not asserted by this check.`,
);
