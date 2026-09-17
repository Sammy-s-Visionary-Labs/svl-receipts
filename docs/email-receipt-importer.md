# Email receipt intake

Mailbox: **recisvl@gmail.com**. Google Apps Script checks every eight hours using
Gmail's read-only scope. Only messages currently in the Primary inbox are scanned
(`in:inbox category:primary`); other categories and archived mail are excluded.
This is Gmail category filtering, not receipt classification: nonreceipt mail in
Primary can still enter review, and receipts in other tabs must be moved to Primary
before a scan while they remain within its date window.
It never sends, deletes, labels, or marks email as read.
The app imports originals into private storage and submits derived receipt pages
through the existing readability, Gemini extraction, intelligence, manager review,
and approved Housecall export workflow. The importer never approves receipts or
runs Housecall dispatch.

## Install the scheduler

1. Configure production-only `EMAIL_IMPORT_SECRET` with at least 32 random
   characters and `EMAIL_IMPORT_OWNER_ID` with an active manager/admin's ID. This
   key only authorizes email import endpoints; do not give Apps Script Supabase,
   Gemini, or Housecall credentials.
2. Sign in to Google Apps Script as **recisvl@gmail.com**. Create a standalone
   project named **SVL Receipt Email Importer**. Copy `scripts/email-importer/Code.gs`
   into its code file and use `scripts/email-importer/appsscript.json` as its
   manifest (enable Show manifest in Project Settings).
3. In Script Properties, set `SVL_IMPORT_SECRET` to the same secret. Optionally
   set `SVL_START_AT` to an explicit ISO timestamp if historical import is wanted.
   Without that property, intake starts at installation time.
4. Run `setupReceiptImporter` and authorize Google access. It verifies the exact
   mailbox and replaces only triggers for this script's importer function.
5. Run `importReceiptEmails` once. Confirm Settings → Email receipts shows recent
   contact, then check the review inbox. Google emails the trigger owner about
   failed script executions; Settings shows preparation failures and retry controls.

No Google password is stored by this app. The Google authorization and Apps Script
properties remain in the receipt account. To stop intake, delete this project's
trigger or remove/rotate the production importer secret. Reinstalling the trigger
preserves its cursor. To change to twice daily, use `everyHours(12)` and rerun setup.

## Transport and recovery

`POST /api/email-imports` accepts a small message ID/byte length/SHA-256 manifest,
returns a private signed upload destination, and binds an immutable original to
one mailbox/message identity. A duplicate message ID with changed bytes is refused.
The script uploads the raw MIME email directly to Supabase, avoiding Vercel's
request-body size limit, then calls `/api/email-imports/{id}/confirm`.
Confirmation downloads and hashes the original before queuing preparation.

A fixed scan window and page checkpoint advance only after every message on that
page has been acknowledged. The next window overlaps the last day, bounded by the
configured start time. Missed scheduled runs catch up from the previous completed
cursor. Replayed pages reuse import IDs; a failed page is retried, never discarded.
An oversized message deliberately stops the cursor and needs administrator action.

Preparation claims a five-minute database lease. All receipt/page/work records for
an email commit together. Deterministic receipt IDs and content-addressed page
objects allow lost acknowledgements and retries without additional receipts.
Transient failures retry with backoff, up to five attempts; terminal failures appear
as Needs attention. Admins can retry preparation. `/api/email-imports/process`
recovers email preparation and extraction only. A daily Vercel recovery cron also
runs at 09:15 UTC. Ordinary confirmation immediately starts extraction work.

## Supported content and limits

- PDF attachments become image pages for the existing OCR/review viewer. Maximum
  five pages per PDF, matching the current receipt review limit. Locked, damaged,
  and longer PDFs are held visibly; no pages are silently dropped.
- Common image attachments are decoded, oriented, and converted to JPEG. Small
  inline signature/tracking images are skipped; SVG and multi-frame image files
  are held rather than executing or truncating them.
- Attached `.eml` forwards are parsed recursively, up to three levels. Inline
  forwarded text is part of the body.
- Plain text and HTML-body receipts are rendered into readable pages. HTML becomes
  inert text; no scripts, remote images, or receipt-download links are fetched.
  Mail headers remain source metadata rather than invented purchase facts.
- Each attachment is a separate receipt document. Financial body content is also
  retained when present alongside attachments. Managers resolve duplicate body/
  attachment copies in the same way as photographed/emailed duplicates.
- Maximum raw email: 40 MiB; 20 receipt documents / 40 rendered pages per message;
  body text: 30,000 characters / five rendered pages. Unsupported non-inline
  attachments hold the entire message for attention.

Original MIME files remain private and downloadable only through a manager-checked
endpoint issuing a fresh, short-lived URL. They retain original PDFs/images. A
shared email original is removed after all linked receipts complete their existing
retention lifecycle. The message identity remains to prevent reimport. Unresolved
imports remain available for investigation; do not silently discard them.

## Duplicate protection

Existing image and semantic matching still run during extraction. Review refreshes
matching evidence, and approval rechecks it under a database transaction lock.
Unresolved candidates block approval. A manager either marks the copy as a duplicate
or explicitly dismisses a false match. Confirmed duplicates cannot create export
work; the canonical receipt can proceed after duplicate copies are resolved.

Matching includes file identity, normalized vendor plus invoice/ticket number, or
vendor/date/total without conflicting transaction numbers. Immutable hashed
transaction/file fingerprints survive receipt-image retention. A match to a
previously approved, purged receipt blocks approval for administrator investigation.
Fingerprints cannot reconstruct originals that were already purged before this
feature was installed. OCR can still misread receipt identity; uncertain evidence
requires manager judgment. This is not a claim of infallible visual matching.

## Validation and deployment evidence

- Unit tests cover PDF rendering, image and forwarded attachments, body rendering,
  invalid/oversized input, importer authentication, and bounded request bodies.
- Apps Script tests cover wrong-account refusal, failed-acknowledgement cursor
  preservation, and direct upload without exposing application credentials to storage.
- Applied SQL checks cover atomic submission, leases, no approval/export bypass,
  role boundaries, duplicate approval blocking, and audited dismissals.
- `scripts/email-importer/concurrency.mjs` is restricted to a local database and
  verifies that simultaneous approval of two copies allows only one transaction.
- Browser tests cover admin import status/retry, narrow-screen layout, and worker
  refusal. Existing manager review tests continue to pass.
- Real Gemini development smoke on 2026-09-16: synthetic PDF import
  `e0aeb627-e41a-4a11-a955-1f63a6054ee9`, receipt
  `47db1e8c-c103-4d56-a41b-2292e5b421bc`, reached `needs_review`, extracted
  TEST EMAIL SUPPLY / 2026-09-16 / $80.00, reused its ID on replay, and had zero
  Housecall outbox entries. Gmail account authorization remains a separate setup step.
