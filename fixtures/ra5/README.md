# RA-5 synthetic receipt fixtures

Every image is an explicitly labeled synthetic test document. These are simulated layouts, not authentic vendor receipts or evidence of purchases. The user's original Downloads JPGs were not modified. Generated with the built-in image_gen tool; the exact prompt sets are saved alongside this README.

The pack contains **13 PNG files**: 11 document cases across 12 generated images (the Perrysburg case has two pages), plus one byte-identical copy for exact-duplicate checks. Expected fields and warnings are in `manifest.json`; controlled job/category fixtures are in `catalog.json`. The fake job IDs must never be submitted to Housecall.

## Images and intended checks

| Case | Image(s) | Check |
| --- | --- | --- |
| Select | [select-multijob.png](images/select-multijob.png) | Handwritten PO references, decimal quantities, two different jobs by line |
| Sandman | [sandman-decimal-mismatch.png](images/sandman-decimal-mismatch.png) | 6.09 × $24.70 computes $150.42 despite printed $151.42; tax stays separate |
| Klumm | [klumm-disposal.png](images/klumm-disposal.png) | Disposal category, conflicting handwriting, exact PO outranks names |
| Lowe's | [lowes-ambiguous-missing.png](images/lowes-ambiguous-missing.png) | Ambiguous date and missing cost remain unresolved, incomplete line retained |
| Perrysburg Pipe | [page 1](images/perrysburg-page-1.png), [page 2](images/perrysburg-page-2.png) | Ordered pages, three material lines, carried-forward amount not duplicated |
| Menards sale | [menards-purchase.png](images/menards-purchase.png) | Simulated itemized sale format and valid material arithmetic |
| Home Depot base | [home-depot-base.png](images/home-depot-base.png) | Two products, printed job reference, original duplicate candidate |
| Home Depot repeat | [home-depot-rephotographed.png](images/home-depot-rephotographed.png) | Same document with different pixels, lighting, folds and perspective |
| Home Depot separate purchase | [home-depot-separate-purchase.png](images/home-depot-separate-purchase.png) | Same products/total, different transaction/date: not a duplicate |
| Menards picking list | [menards-picking-list.png](images/menards-picking-list.png) | Explicitly not a receipt; price stays missing and document requires review |
| Fuel | [fuel-category.png](images/fuel-category.png) | Fuel category, gallon vocabulary, 10.125 × $3.80 rounds half-up to $38.48 |
| Exact duplicate | [home-depot-exact-copy.png](images/home-depot-exact-copy.png) | Identical bytes to the Home Depot base; exact image-hash match |

## Verification

All 11 document cases were visually inspected against their expected fields and run through the actual `gemini-3.5-flash-lite` adapter. The retained results in `evaluation/gemini-results.json` include input SHA-256 hashes, model/prompt versions, latency, usage, normalized synthetic predictions and field checks. They exclude credentials and full raw provider output. One multipage result omitted some field evidence; that omission correctly became a visible `missing_evidence` review warning rather than fabricated confidence.

From the repository root, run:

```sh
npm run test:ra5:fixtures
```

This verifies that retained live results match the image bytes, controlled job/category results are correct, and the near-duplicate and legitimate-purchase pair behave differently. It makes no provider calls.

To repeat the actual Gemini evaluation using the existing server environment, run:

```sh
RA5_GEMINI_ENV_FILE=/absolute/path/to/apps/web/.env.local npm run test:ra5:gemini
```

Set `RA5_FIXTURE_IDS` to a comma-separated subset to rerun particular cases. Selected cases replace their prior results; unselected evidence is retained. Reformat the generated report with `npx biome format --write fixtures/ra5/evaluation/gemini-results.json` before committing. Model/prompt or scoring changes require another relevant regression run.

## Deferred limits

1. Representative **real-vendor** extraction accuracy, including authentic Select/Klumm examples.
2. **Live Housecall** catalog synchronization and verification of real job assignments.

These remain open by explicit user direction. The synthetic pack establishes controlled software behavior, not either deferred claim. RA-36 and its provider-comparison subtasks are excluded; Gemini Flash remains selected.
