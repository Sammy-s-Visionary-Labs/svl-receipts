# Domain contracts (RA-75) — locked

**Status:** Locked 2026-08-05

## Layout (`packages/domain/src/`)

| File | Owns |
| --- | --- |
| `index.ts` | Public re-exports |
| `roles.ts` | `worker` \| `manager` \| `admin` |
| `authz.ts` | Server-side role/ownership helpers + error codes |
| `receipt-status.ts` | Receipt lifecycle statuses + terminal helpers |
| `readability.ts` | **RA-3:** `checkReadable` domain result + reason codes (no vendor JSON) |
| `worker-status.ts` | **RA-3:** device queue, worker chips, sign-out policy |
| `extraction.ts` | Extraction v1 + `schema_version` |
| `review.ts` | Review decisions + light command payloads |
| `housecall.ts` | Step kinds/statuses + intent `payload_version` |
| `money.ts` | Deterministic cents helpers |
| `legacy-status.ts` | Map legacy status names → current |
| `upload.ts` | Upload constraints, page-manifest digest input, and storage-key rules (RA-17 / RA-23) |
| `upload-telemetry.ts` | Allowlisted capture-to-confirmation metrics; drops receipt contents, GPS, URLs, tokens, and free-form errors |
| `storage-errors.ts` | Which Storage error codes mean the receipt object is gone |
| `audit.ts` | Append-only audit actions + payload redaction (RA-18) |
| `work.ts` | Leased work-queue kinds, retries, dead-letter, persistable error codes (RA-18) |
| `outbox.ts` | Housecall outbox / approve intent snapshot (RA-18) |
| `retention.ts` | 365-day retention helpers (RA-19). **Start event is RA-66**, not upload confirmation — see [architecture.md](architecture.md). |

`@svl/integrations` is unchanged in RA-75 (no premature adapter interfaces).

## Locked choices

| Topic | Choice |
| --- | --- |
| Qty type | `number` |
| Confidence | Per-field record |
| Review payloads | Light types (not full API surface) |
| Runtime validation | TypeScript only (no Zod yet) |
| Money | Integer cents; extended cost in app code |
| Extraction / intent versions | `schema_version: 1`, `payload_version: 1` |

## RA-3 capture addendum (2026-08-19)

These choices sit on top of the locked RA-75 vocabulary. They do not replace `receipts.status`.

| Topic | Choice |
| --- | --- |
| Pages per receipt | 1..`MAX_RECEIPT_PAGES` (5) |
| Unreadable lifecycle | Keep top-level `rejected_unreadable`; reasons in `readability.ts` |
| Worker chips | `worker-status.ts` — no Needs clarification |
| Readability vs RA-5 | RA-3 ships `ReadabilityCheckV1` only; `parseReceipt` / bake-off stay RA-35 / RA-36 |
| Queue sign-out | Do not delete; resume only for the same `owner_user_id` |
| Upload persistence | `receipt_pages` is authoritative for ordered 1..5 objects; legacy receipt image columns point at page 1 |
| Active retry identity | Client-generated UUID is both idempotency key and receipt ID; retries cannot create a second internal receipt |
| Sent truth | Device status becomes Sent only after `submit_confirmed_receipt_set` durably acknowledges every page checksum |
| RA-23 / RA-24 boundary | RA-23 retries the active capture safely; RA-24 adds encrypted restart/offline persistence, backoff, and same-owner auto-resume |
| RA-25 provider | Gemini 3.5 Flash-Lite, high image resolution, minimal thinking, structured readability-only output |
| Readability failure | Provider errors retry/dead-letter to `failed`; they never produce `rejected_unreadable` without a normalized unreadable result |

## Out of scope here

Full receipt extraction/OCR, extracted financial fields, and full Housecall REST types.
