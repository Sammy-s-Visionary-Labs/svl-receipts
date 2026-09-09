# RA-6 synthetic export fixtures

This pack describes synthetic, deterministic test inputs and expected outcomes. It is **not a record of live Housecall testing**, a seed for the real job catalog, or a claim that OCR has produced these values from the user's photos.

- `manifest.json` defines receipt lines, expected integer-cent costs, destination aliases, duplicate relationships, and export/recovery scenarios.
- `generated-images.json` tracks nine planned image paths, actual byte hashes and dimensions once available, generation provenance, and separate visual-review/OCR status. Planned records contain no invented output metadata.
- `live-bindings.template.json` deliberately contains no HCP IDs and no approval. A fixture alias must never be passed as an HCP job ID.
- `verify.mjs` checks internal arithmetic, routing expectations, duplicate relationships, source availability, and the absence of live bindings. Run `node fixtures/ra6/verify.mjs` from any directory. It makes no network calls and loads no environment files.
- `../../docs/ra6-test-plan.md` defines the staged test procedure and the live-write approval boundary.

The user's five source JPGs remain unchanged in Downloads. The first two are alternative photos of the same Select Stone order, not two independent purchases. The new image set uses visibly synthetic identifiers and replaces customer references with `RA6 Test Customer 2`, `RA6 Test Customer 3`, and `RA6 Test Customer 4`. **All nine PNG files are generated and visually accepted against the logical manifest.** Actual file hashes, dimensions, prompts, provenance, and individual review notes are recorded in `generated-images.json`. App-model extraction of these new images has not been executed.

| Case | Images | Check |
| --- | --- | --- |
| Select fractional | [Base](images/select-fractional-base.png) | 0.5 ton × $42.00; $1.63 tax stays separate |
| Same Select document | [Exact copy](images/select-fractional-exact-copy.png), [another photograph](images/select-fractional-rephotographed.png) | One document identity, two image-duplicate controls |
| Separate Select purchase | [New purchase](images/select-fractional-separate-purchase.png) | Same items and total; different document ID and date |
| Klumm two jobs | [Two-job receipt](images/klumm-two-jobs.png) | Customer 4 $99.00; Customer 2 $45.00 |
| Handwritten Sandman | [Handwritten ticket](images/sandman-handwritten.png) | Customer 2, 2 yd3 × $40.00 = $80.00 |
| Consolidated Sandman | [Six-line invoice](images/sandman-shop-and-missing-job.png) | Missing job hint and Shop remain unresolved |
| Multipage rounding | [Page 1](images/half-up-two-pages-page-1.png), [page 2](images/half-up-two-pages-page-2.png) | $1.01 + $38.48 = $39.49; complete page set required |

Klumm's first generated draft contained unwanted invented address text. A further imagegen edit removed that text before acceptance; the initial output hash, prompt, rejection note, and final correction are retained in the provenance chain. Only the accepted final PNG appears in `images/`.

Previously generated, visibly synthetic RA-5 images are referenced only as existing image/OCR controls. Their printed names and numbers remain the RA-5 names and numbers, so they do not yet exercise the new RA-6 customer-name mapping. The new RA-6 logical fixtures can exercise an in-memory/mock export boundary without any image generation or live access.

`Shop` and a line without a reliable job hint remain unresolved. Their presence blocks approval/export of the entire consolidated fixture under the current manager contract. There is no assumed overhead job, automatic deletion of these lines, or implied permission to send them to a customer job.

All expected success, failure, and write counts in the manifest are **assertions for tests to exercise**, not results from an executed integration test.

## Recording generated images

For each actual returned output, copy the file to its planned `images/*.png` path, change that asset's `status` from `planned` to `generated`, and record SHA-256, byte length, PNG width and height from the copied file. Keep visual review at `not-reviewed` until the image has actually been inspected against the expected receipt fields. `accepted` visual review requires a named reviewer, review timestamp, and `checkedAgainstManifest: true`; text/amount deviations belong in review notes and should be rejected or explicitly resolved before acceptance.

Use this provenance object for an imagegen result; the prompt must be the exact prompt supplied to the tool, and its SHA-256 is computed over UTF-8 prompt bytes:

```json
{
  "method": "imagegen",
  "tool": "image_gen.imagegen",
  "recordedAt": "actual UTC timestamp when the output is recorded",
  "toolOutputPath": "actual local path returned by the tool",
  "prompt": "exact generation prompt",
  "promptSha256": "actual SHA-256 of the prompt"
}
```

For the byte-identical duplicate, use `method: "byte-copy"`, `tool: "filesystem.copy"`, and the actual `recordedAt`; `prompt`, `promptSha256`, and `toolOutputPath` are null. The record's `sourceAssetId` points to `select-fractional-base`. Its image SHA-256 must equal that source. A rephotographed variant must instead have different bytes while retaining the document identity and expected fields.

The verifier counts generated and visually accepted assets separately. It verifies file metadata and recorded provenance; it cannot certify image text or extraction accuracy. `extractionEvaluation.status` stays `not-run` until a retained, actually executed evaluation report is available. Neither generated images nor accepted visual review authorizes a Housecall write.

Several images print dates in the intended US numeric form, such as `09/01/2026`. The strict RA-5 normalizer may correctly leave such dates unresolved without a verified date-order convention or manager confirmation. The manifest records the intended synthetic date; visual acceptance does not establish that extraction resolves it automatically.
