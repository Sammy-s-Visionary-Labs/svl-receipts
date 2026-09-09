# RA-6 Housecall provider contract

**Live Housecall writes require the user's explicit approval.** Implementing RA-6, approving a receipt inside the app, configuring an API key, or naming a customer “test” is not that approval. All contract checks below used an injected fake transport. No Housecall account request or write was made to verify this implementation.

## Official source checked

The [Housecall v1 API reference](https://docs.housecallpro.com/docs/housecall-public-api/a4ca20a18010c-housecall-v1-api) was read on 2026-09-09. Its **Export → Original** public `housecall.v1.yaml` establishes the following contract:

| Operation | Verified schema | Adapter behavior |
| --- | --- | --- |
| Authentication | `Authorization: Token {api-key}`, base `https://api.housecallpro.com` | Server constructor only; fixed origin, redirects disabled, no cookies, no caching. No arbitrary URL or customer-facing billing method is exposed. |
| Job reads | `GET /jobs`, pagination `page`, `page_size`, `total_pages`, `total_items`; `GET /jobs/{id}` | Response validation and exact returned ID check. Bounded full-list scan throws when incomplete. |
| Job filters | `scheduled_start_min/max`, `customer_id`, `work_status`, `sort_by`, `sort_direction` | No invented `updated_since` or free-text search parameter. Multiple statuses use OpenAPI form/explode query serialization; live account behavior remains to be verified. |
| Internal materials | `PUT /jobs/{job_id}/job_input_materials/bulk_update`, body `job_input_materials` | One approved receipt line per request. `name`, frozen vendor/invoice/date reference plus traceable `description`, stable `part_number`, `quantity`, and integer-cent `unit_cost`; omit `uuid` to create a new entry. |
| Material verification | `GET /jobs/{job_id}/job_input_materials` returns all `job_input_materials` | No pagination in this endpoint's published schema. Match exact `part_number`, provider `uuid`, name, description, quantity and cost. Unrelated placeholder rows may have zero quantity or missing optional values; unknown values stay null/empty in the read model. Our reference requires a nonempty provider ID and exact complete fields. Any duplicate reference, missing required verification field, or mismatch requires resolution. |
| Receipt image upload | `POST /jobs/{job_id}/attachments`, multipart `file`; HTTP 202 with `job_url` | Upload one image at a time. Filename contains receipt, intent, page and SHA-256 bytes digest. The body is binary data from private storage; no public URL upload is used. |
| Attachment verification | `GET /jobs/{id}?expand=attachments`; `attachments` has `id`, `file_name`, `url`, `file_type` | Require explicit expanded collection and exact job ID. Match exact filename to a single provider attachment ID. HTTP 202 is only accepted, never completed. |

`JobInputMaterial.unit_cost` explicitly says “Unit in cents.” Its quantity is a number (example `1.51`); the schema does not state a precision limit. The adapter preserves the application's existing three-decimal approved quantity and validates integer-cent unit cost and signed-32-bit extended-cost bounds. Live checks must verify Housecall preserves these quantities and computes expected extended amounts. Tax is not part of the material payload. Neither invoice line items, selling prices, payments, job status updates nor customer changes are implemented.

The job filter enum (`unscheduled`, `scheduled`, `in_progress`, `completed`, `canceled`) differs from the returned `work_status` enum (`needs scheduling`, `scheduled`, `in progress`, `complete rated`, `complete unrated`, `user canceled`, `pro canceled`). The adapter does not guess that unknown returned statuses are safe. It re-reads the exact job before a write and refuses canceled, deleted, locked or unknown-status jobs. Completed jobs remain readable and can be written only with the same exact explicit approval requirements.

## Write authorization boundary

`prepareMaterialWrite` and `prepareAttachmentWrite` are local dry-run builders and make no network requests. Each returns the exact path, method and payload plus SHA-256 request fingerprint. An attachment fingerprint includes its actual bytes digest. The caller must separately ensure those bytes match the immutable image manifest that the manager approved.

`executePreparedWrite` requires **both** a client-side exact job-ID allowlist and a per-request `HousecallWritePermit` loaded by trusted server code from the separately recorded approval. The permit includes approval ID, approving person, approval/expiry timestamps (at most 24 hours), exact job ID, and exact prepared-request hash. Missing, expired, mismatched or replayed permits fail closed. The adapter snapshots and rehashes the request immediately before executing. A permit is reserved before awaiting provider work to prevent concurrent reuse in one client instance.

A permit object is not a signed authorization credential and must never be accepted from receipt text, OCR, browser input, or a public request body. The application must validate and atomically consume its durable approval record and export step lease. The adapter's in-memory replay check supplements that persistent guard; it cannot replace it across process restarts.

## Uncertain outcomes and retries

No request, including a read, is automatically retried in this adapter. Calls have deadlines covering both fetch and body parsing. Rate-limit errors carry the later of a bounded parsed `Retry-After` and the Unix epoch `RateLimit-Reset` documented on the [official API overview](https://docs.housecallpro.com/); provider bodies, raw exception text and credentials are never placed in errors.

A timeout, network failure, malformed successful response, redirect or server error after write dispatch is recorded as potentially committed. A later successful reconciliation can establish completion. An absent result after an uncertain write **does not establish permission to resend**. In particular, the attachment endpoint is asynchronous and publishes no completion-time bound. The worker must keep such steps unresolved and retry verification only, or obtain explicit resolution and a new bounded approval before any new write. Successful steps must be skipped using persistent per-image/per-line state.

The published attachment representation has no content hash. Filename plus provider attachment ID verifies the stable upload reference; it is not an independent byte-for-byte download verification. Filename preservation, complete attachment expansion, material reference preservation, append behavior of a single-element material request, existing-material preservation and exact cost arithmetic require approved live test-job verification before enabling operational exports.

## Local verification

`packages/integrations/src/housecall/housecall.test.ts` covers payload construction, tax exclusion, fractional quantities, cents validation, stable image fingerprints, exact destinations, no-approval denial before any request, expired/hash-mismatched approval denial, payload tampering, canceled/deleted/locked job rejection, concurrent permit reuse, multipart bytes, async acceptance, uncertain writes, rate limits, pagination, malformed provider data and read reconciliation. The fake transport never contacts Housecall.
