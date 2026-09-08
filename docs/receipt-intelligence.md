# RA-5 receipt intelligence and manager controls

RA-39 duplicate detection, RA-40 local job ranking, and RA-41 categories/feedback run after receipt normalization, within the extraction worker. The worker reads the saved Housecall catalog. These modules make no Housecall API calls and never approve receipts or create export intents themselves.

## Duplicate review

Exact duplicate candidates compare the complete set of confirmed page checksums. A matching single page in a longer document is insufficient. The worker records exact candidates before calling Gemini, so duplicate evidence remains available during provider failures.

Semantic scoring uses vendor (15), date (20), amount (15), and matching vendor plus invoice/ticket identifier (55). Conflicting known invoice/ticket numbers subtract 70. Evidence scores are weights, not probability estimates. The default candidate threshold is 45. Different photographs can match semantically; distinct transaction numbers prevent superficially similar Home Depot purchases from matching.

Manager receipt review shows candidate links, scores, reasons, and decisions. “Review as duplicate” opens the existing manager review dialog with the proposed canonical ID; a reason and explicit confirmation remain required. “Dismiss candidate” records a decision without blocking approval. Confirmed duplicates remain linked to one canonical receipt and cannot create export work. Candidate retrieval respects purge fences on both receipts; retention removes linked intelligence.

## Job suggestions

Only immutable IDs already present in `manager_job_catalog` are eligible. Receipt text never creates job IDs. The ranker returns a leading candidate and at most five candidates for the receipt and, where present, each material-line hint. Printed and handwritten references retain their text evidence. Exact job/PO matches outrank names; an exact line reference outranks a receipt-wide reference for that line. Scores do not accumulate from repeated copies of the same hint.

Customer matching supports exact and partial names. Supporting signals include scheduled date, active status, assigned worker IDs, uploader history, vendor history, and capture proximity. GPS is optional. Distance scoring requires coordinates within valid bounds, a nonempty service address, and a capture accuracy within the configured limit. Catalog fields absent before RA-6 synchronization simply contribute no evidence.

The manager sees reasons and can assign all lines or a specific line. All assignments remain editable. Re-extraction retains saved edits. Source line IDs contain the extraction ID and original source index; filtered tax/summary rows do not renumber this identity. When the newer extraction differs from the saved review, stale suggestion references are cleared and original line evidence is loaded from its true source extraction. Feedback retains that source version.

## Categories

No production categories are seeded. An administrator configures Sam’s approved list in Settings, including stable lowercase IDs, display labels, keywords, and active state. Approval requires an active configured ID; unknown values remain review drafts. Deactivated categories stay readable in historical reviews. The configuration has a 500-category bound and records its actor/version. Ambiguous keyword matches return no category. Synthetic test categories are fixtures, not a production approval.

## Feedback and controlled evaluation

A review transaction records original and final header values, line fields, job choices, actor, source extraction, model/prompt version, and scoring version. New manual lines have no fabricated model source. Feedback is immutable; it does not train, tune, or otherwise change production behavior.

Administrators can download `/api/admin/intelligence/evaluation`. Each JSON page contains up to 500 allowlisted field pairs, retains numeric quantity/cost values, and uses per-page HMAC pseudonyms for text and identities. It omits manager notes, raw receipt text, provider payloads, credentials, and arbitrary JSON. Follow `nextPage` in the JSON when present. Pseudonyms are comparable within one export page only; the ephemeral HMAC key is neither returned nor persisted. Cross-page field-pair counts and numeric-error totals can be aggregated, but these exports cannot join a receipt, review, or actor across pages or across separate downloads. A long review may span pages, so do not use this export to compute whole-receipt or per-review grouping metrics. Model, prompt, and scoring versions are preserved after strict character validation. Pseudonymous review IDs, decisions, and review versions distinguish draft corrections from final approval decisions; use final approval records when measuring final extraction/assignment accuracy. This is suitable for numeric accuracy and acceptance/correction analysis; textual tuning requires explicitly reviewed, sanitized fixtures rather than recovered personal text.

The manager can request field evidence on demand through the actor-checked evidence endpoint. It returns only structured field evidence for an extraction on the selected receipt. Full raw text and original provider response remain in restricted storage.

## Configuration and regression gate

These server environment variables are validated before enrichment. Defaults are explicit, and resolved thresholds are encoded in each scoring version so changed behavior can be traced:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECEIPT_DUPLICATE_THRESHOLD` | `45` | Minimum duplicate evidence score (0–100) |
| `RECEIPT_DUPLICATE_AMOUNT_TOLERANCE_CENTS` | `0` | Whole-cent tolerance for matching receipt totals |
| `RECEIPT_JOB_MAX_GPS_ACCURACY_METERS` | `100` | Maximum capture accuracy uncertainty allowed for distance scoring |
| `RECEIPT_JOB_MAX_DISTANCE_KM` | `10` | Proximity radius for the supporting distance signal |
| `RECEIPT_JOB_MIN_SCORE` | `8` | Minimum score to return a job candidate |

Before changing prompts, keywords, or thresholds, run the normalized extraction fixtures, duplicate-positive and negative controls, competing-name/exact-reference and line-assignment tests, and manager regression tests. Do not promote a tuning change solely because acceptance counts rose. Real-vendor receipt accuracy and live Housecall synchronization/assignment verification remain explicitly deferred; synthetic fixtures and local catalog tests do not satisfy those two limits.
