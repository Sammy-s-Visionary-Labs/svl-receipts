# Labor Hours and Jobs development

Use an isolated development checkout and private source files to review labor ingestion and allocation before release. The current production integration and rollout checks are in [labor-production.md](labor-production.md); this document describes the local workflow. Real customer addresses, employee identities and hourly rates must stay in private source data and saved controls. Use synthetic `TEST Customer`, `TEST Worker` and `TEST Address` examples in public documentation and fixtures.

## Local preview

The loopback preview provides `/labor-hours` and `/jobs`. Enable `LABOR_DEVELOPMENT_ENABLED=1` and `LABOR_LOCAL_PREVIEW=1` in a private development environment, with filesystem persistence. `NODE_ENV` must be `development`. `npm run dev:labor-web` binds to `127.0.0.1:3145`; a separately configured local development server may use another port. Never use the local preview bypass in preview or production deployments.

Labor Hours includes Timesheet/Notes XLSX uploads, import history, authorized original downloads, source CSV exports, worker/date filters, allocation review, saved rules, Housecall job-link review, and weekly pay estimates. Source entries retain their original clocks, signed Hours, row numbers, travel flags and source costs. Travel is already included in source hours and must not be added again. The Jobs view combines canonically linked allocated intervals and each receipt's assigned line amounts; receipt-only jobs and unassigned portions remain visible.

The private ledger and original workbook files live under `.local/labor/`; an optional `LABOR_DATA_DIR` selects a different private directory. Do not commit ledgers, originals, cookies, environment files or worker tokens. Shared-persistence development testing uses `LABOR_PERSISTENCE=supabase` with a separate development database and the production runbook's migration checks. Enabling shared persistence disables the local manager bypass and requires the existing receipt-app login/roles.

## Source acquisition and versioning

The standalone worker uses Supercrew's normal Timesheet Report / All Entries view with all jobs, workers, entry types and statuses included. It also downloads the Notes Report with only Daily Timesheet Note selected, all note owners/jobs included, and Search cleared. The worker verifies the company and exact completed-date range before exporting. Both workbooks must parse successfully before either becomes active. See [worker setup](supercrew-worker-dev.md).

The Notes workbook omits report-period and note-type metadata. Acquisition therefore records the requested period and verified Daily Timesheet Note scope separately. Mixed manual notes uploads require explicit daily-type/date verification before comments can correct allocation. Employee is the note owner; Notetaker is a separate retained field. Unrelated note bodies stay in the private original rather than the job-comment view.

Repeated file hashes identify duplicate uploads. Complete overlapping exports replace covered dates according to source generation time; re-uploading an older export cannot roll hours back or add duplicate payroll quantities. Dates beyond an export's generation date do not erase later known source facts. Paired Notes follow the winning Timesheet snapshot for each covered date. Original files, import summaries and source row links remain available for review.

Workbook ingestion bounds compressed and expanded size, worksheet/row/cell counts, and accepted structures. HTTP uploads allow 2 MiB per XLSX and 4 MiB per entire multipart request including overhead; the separate 10 MiB parser/download/Storage ceiling does not increase that upload allowance. Filtered Timesheets, unsupported note scope and out-of-period normalized note dates are rejected before activation. Source detail totals and independently published totals are kept separately, including their reconciliation warnings.

## Allocation and estimates

Allocation rules classify each imported location as customer, supplier, shop, excluded or unknown. Source identity is the lossless name/address grouping key; it is not a provider job ID. A customer classification creates a reviewed source destination. Housecall job identities are confirmed separately with an explicit imported-date range and catalog evidence. Source rules cannot arbitrarily supply provider identity. Future imports do not inherit old scoped links automatically.

Initial shop time and supported final returns are excluded from customer jobs. Travel and intermediate supplier/shop paths follow the next reviewed customer when continuous clocks and source evidence support that destination. Unknown locations, clock warnings, contradictory comments, ownership ambiguity, overlaps and missing boundaries remain pending. Explicit excluded locations keep their source rows, clocks, gross worker-day hours and lunch eligibility while contributing no customer-job hours.

A verified worker-day job-only comment can allocate a supported abnormal interval. Source-specific `TEST Job A = TEST Job B` or `TEST Job A is TEST Job B Job` corrections apply only to matching A source intervals for that note owner and date; unrelated intervals retain their own destination. Scoped aliases require both a worker and date. Failed or conflicting corrections keep their note provenance and useful target suggestion visible in review.

Daily lunch uses the complete gross worker day: one half-hour adjustment at six hours or more. It is a worker-day adjustment rather than a job allocation. Published source break rows remain visible and are compared with the policy rather than deducted twice. Job hours retain their allocated source intervals.

User-approved worker rates and weekly overtime settings persist in the private controls and apply as estimates to the imported source history. Blank rates remain unspecified; inactive workers' historical hours are retained. Incomplete weeks and missing rates stay visible. Original Supercrew costs and payroll records remain unchanged. Assigning overtime/pay to individual jobs and posting labor to Housecall require a separate reviewed policy and are not configured by the weekly estimator.

## Local worker operations

Run the local web preview and worker in separate terminals. Private worker setup uses the same development `LABOR_WORKER_TOKEN`, an exact loopback `LABOR_APP_URL`, and `SUPERCREW_REPORT_DOWNLOADS_APPROVED=1` only for the approved normal report-download scope.

```sh
npm run dev:labor-web
# Separate terminal:
npm run dev:labor-worker
```

With the watch worker stopped, run `npm run dev:labor-connect` and complete normal Supercrew login in its isolated browser, or use the local Connect Supercrew control. Do not start two workers against one profile. The private profile, downloads and worker state live under `.local/labor-worker/`. Do not read an unrelated browser profile or ask for credentials in chat.

The default schedule is 06:00 America/New_York for the previous fourteen completed dates. The schedule can be paused, its hour and 1–31 day lookback edited, and a manual download requested. The worker polls locally, uses Eastern calendar dates across daylight-saving changes, and avoids repeating consumed commands after uncertain responses. Expired authentication requires reconnection and remains visible as sign-in required. A local recurring worker requires the machine and processes to keep running; the hosted finite workflow is documented separately in the production runbook.

Before removing a stale lock, verify that the corresponding web/worker process is stopped. A worker interrupted after upload may already have imported records; inspect import history and hashes before requesting another export. Never delete source originals or the private ledger simply to reset a status.

## Validation

Run the domain, integration, labor/web and worker tests, typechecks, scoped formatting, and a production-mode build. Test source generation ordering, overlapping replacement, paired-note ownership, excluded locations, scoped comments, complete worker-day lunch, weekly overtime, unknown rates, conflicting revisions, full-catalog matching and canonical receipt splits. Inspect actual browser screens for original provenance, pending review, date filters and account access. Shared-persistence and managed-worker acceptance require the production runbook's additional database and lease tests.
