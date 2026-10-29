# Supercrew Excel worker — development only

This worker downloads Supercrew's normal Timesheet and daily Notes reports and sends both XLSX files to the
local receipt application's development importer. It does not change source
timesheets or write anything to Housecall Pro. The importer applies Marcy's
confirmed October 1 allocation rules while preserving source hours. Pay rates
and cost treatment remain separate.

## Verified source behavior

Inspected the signed-in Supercrew web application on September 29, 2026:

- URL: `https://app.supercrew.com/reports`.
- Account label: `Sammy’s Visionary Landscape`.
- Select **Timesheet Report**, then **All Entries**. With the Job, Worker and
  Time Entry Type filters cleared, this report covers all workers and jobs.
- Jobs Report is unsuitable as the initial all-job acquisition path: a clean
  view asks for job selection and says that at most ten jobs can be selected.
- The filter dropdowns expose `listbox` / `option` roles and `aria-selected`.
  Worker search can retain earlier text; the worker clears `Find Worker…` and
  `Find Job…` before removing selected options.
- The date button opens a tooltip with **Custom** / **Pay Period**. Custom uses a
  calendar grid named by month and year, numeric day gridcells, and **Go to
  previous month** / **Go to next month**. The worker checks the visible final
  date label before downloading.
- **Download Excel** produces an XLSX from Supercrew's signed report storage:
  `https://construction-userdata-production-036207347308-ca-central-1.s3.ca-central-1.amazonaws.com`.
  The user approved this report-download scope on September 29, 2026.
- A normal browser download succeeded for
  `TimesheetReport_Thu_Sep24_2026_Wed_Sep30_2026.xlsx`. This validates the source
  download through the user's existing session. The isolated paired workflow was
  subsequently verified on October 1, as described below.
- Timesheet All Entries contains `Crew` in addition to Date, Name, Job, clock
  times/methods, entry type, Hours, Labor Cost, Billable Cost, Job Code and
  Employee ID. **Unpaid Break** rows contain deductions and missing clock times;
  the importer must preserve them separately from positive job time.

## Run the shared local app and queue worker

For the local site backed by the shared development database, run this from the
repository root:

```sh
npm run dev:labor
```

`npm run dev` is an alias for this command at the repository root. From a terminal
in another directory, supply the path to the intended checkout:

```sh
npm --prefix "/absolute/path/to/receipt-app" run dev:labor
```

The environment-file paths are relative to the repository root, so do not run
the raw `node --env-file=.env.local` command from a different folder. The local
website uses Next's supported Webpack development mode to avoid the observed
Turbopack empty-update reload loop. Production builds keep their existing bundler.

This starts the website at `http://127.0.0.1:3150` when needed, waits for its
authenticated worker endpoint, and then starts the queue worker. If a matching
site is already running, it reuses that site. The supervisor only stops the
processes it started.

Both commands in this section load the ignored `apps/web/.env.local` and
`apps/web/.env.labor-stage` files. Keep their credentials private. The shared
development configuration needs `LABOR_ENABLED=1`,
`LABOR_DEVELOPMENT_ENABLED=1`, `LABOR_PERSISTENCE=supabase`, and the intended
development Supabase settings. Configure the worker in that private environment:

- `LABOR_APP_URL=http://127.0.0.1:3150`.
- `LABOR_WORKER_TOKEN`: at least 32 characters, matching the website's private
  worker credential.
- `LABOR_SESSION_ENCRYPTION_KEY`: exactly 64 hexadecimal characters, matching
  the key used to encrypt the connected Supercrew session.
- `SUPERCREW_REPORT_DOWNLOADS_APPROVED=1`: permits the normal report-download
  scope already approved by the user.

The supervisor rejects non-loopback destinations, invalid credentials or
encryption keys, and a missing approved-download flag before starting anything.
It starts no worker until the website responds with the authenticated shared
worker contract. A mismatched token fails immediately; an unavailable website
has a bounded startup wait.

When the website is already running and only the worker is needed, use:

```sh
npm run dev:labor-watch
```

This command waits for the configured existing website and never starts another
website. Keep the terminal open while using **Queue download**. A queued manual
request can run while recurring downloads are paused. Starting the worker can
therefore immediately claim an existing request. Neither command enables the
recurring schedule or sends labor hours to Housecall.

Press Ctrl+C to stop the supervisor. It stops its worker first, then its own
website; a website it reused remains open. These commands do not install an OS
background service. If this local worker exits unexpectedly, its website stays
available and the terminal explains that this worker is not running. Fix the
reported worker issue and restart the command to resume it; the supervisor does
not repeatedly restart a failed worker. Do not run a second worker beside them. If the Supercrew
session expires, stop the worker and follow the normal isolated connection
setup in the [hosted worker guide](../scripts/supercrew-worker/README.md).
Chromium must already be installed for the pinned Playwright version. The hosted
GitHub finite workflow remains a separate deployment option using the same
lease-protected paired-import protocol.

Shared development and production use the server-owned recurrence and catch-up
rules in the [hosted worker guide](../scripts/supercrew-worker/README.md#recurrence-and-missed-dates):
daily, weekly, biweekly, or a custom 1–365 calendar-day interval. Saving settings
preserves the paused/enabled state. Missing dates since the last verified paired
coverage are collected in resumable batches of at most 31 days, independently
of the 1–31-day recent correction window. While paused, one explicit queued
download claims one batch; the app shows remaining dates until the manager queues
another batch or enables recurring downloads.

## Run the local development worker

This older flow uses the filesystem development ledger and its isolated browser
profile on port 3145. Use the shared commands above for the shared database;
the legacy `dev:labor-worker` and `dev:labor-once` commands do not supply shared
worker leases or coverage-aware catch-up. Their recurrence support only downloads
the configured recent window, so they must not be used as the production path
for intervals longer than that window.

The Notes Report interface was inspected on October 1. It exposes Job,
Notetaker, Notes For, Note Type and Search filters. Acquisition clears all
restrictions before selecting only **Daily Timesheet Note**; selected options and
unrestricted owner/job coverage are rechecked after selecting the period. The
Excel omits Note Type and period metadata, so acquisition scope and requested
dates travel with the paired upload. Mixed manual uploads require separate
daily-comment and date verification in the development app.

Start the local development receipt app first. Keep this legacy workflow on its
default loopback destination, `http://127.0.0.1:3145`. Shared deployed endpoints
require the hosted worker's lease protocol. Credentials in URLs, paths, query
strings and redirects are rejected. Both app and worker need the same private
`LABOR_WORKER_TOKEN` of at least 32 characters.

```sh
npx playwright install chromium
npm run dev:labor-web
# In a second terminal:
npm run dev:labor-worker
```

The npm worker commands load the ignored `apps/web/.env.local` with Node's
`--env-file`. Configure `LABOR_APP_URL=http://127.0.0.1:3145`, the shared private
`LABOR_WORKER_TOKEN`, and `SUPERCREW_REPORT_DOWNLOADS_APPROVED=1` there. Do not
commit the token or paste it into chat. The flag permits only the report transfer
approved above. Without it, the worker refuses to trigger a live export and
blocks requests to that report origin.

The development **Connect Supercrew** action opens a dedicated headed browser.
Sign in there normally, including MFA if requested. Its authentication stays in
the private isolated profile; the worker never reads the user's Chrome profile
or asks for a password in chat. Setup waits at most ten minutes for the company
label or report UI; if sign-in returns to the dashboard, it opens Reports and
verifies the expected company before accepting the connection. The standalone
connection command is:

```sh
npm run dev:labor-connect
```

Once connected, use **Download now** in development or run:

```sh
npm run dev:labor-once
```

Only one worker process may own this development profile. A second process is
blocked by `.local/labor-worker/worker.lock`. The worker can reclaim a lock only
when its recorded owner is confirmed absent. A live, unverifiable, malformed or
actively recovering lock remains protected and produces a specific diagnostic.
Do not delete a lock merely to bypass that check; stop the owning worker first.

## Scheduling, ingestion and status

`--watch` polls the local development worker endpoint every 15 seconds. The app's
sync configuration controls enablement, interval, hour, time zone and lookback.
Defaults are daily at 6 a.m. America/New_York and the previous 14 completed
calendar dates. Recurrence accepts 1–365 days; this legacy flow's lookback remains
limited to 1–31 days. Automatic attempts begin only after a
successful isolated connection records `connectedAt` locally. A newly started
worker preserves the app's `not_connected` state and does not attempt exports.
Expired login needs another connection. If the worker first connects after the
scheduled hour, it catches up once. DST uses
Eastern calendar dates, not a fixed UTC offset.

Idle and successful heartbeats update the next run timestamp using the configured
local hour and time zone. Paused, unconnected or expired-login states show no
scheduled timestamp. Spring and fall transitions use the next actual local
schedule occurrence rather than a fixed UTC offset.

The worker records the local date when an attempt starts. A failed download
consumes the configured interval; it can be retried by a new **Download now**
action, and does not re-export every poll. A successful manual run restarts the
interval. An expired login needs reconnection. Command IDs are consumed locally before execution, preventing an
uncertain heartbeat from repeatedly executing the same command.

All interface failures are bounded: exact-date selection is verified, filters
must clear, signed-in account must match, and download waits at most 90 seconds.
There is no private Supercrew API, scraped token or separately fetched signed
URL. The browser's normal download/response supplies the workbook. Unexpected
download origins are cancelled. XLSX ZIP signatures and a 10 MB development
limit are checked before uploading; the application's workbook parser performs
the structured validation.

The local token-authenticated contract is:

- `GET /api/manager/labor/worker` → `{ sync }`.
- `POST /api/manager/labor/worker` receives heartbeat status (`idle`, `running`,
  `needs_login`, `failed`), `lastError` limited to 500 characters, attempt/success
  and next-run timestamps and
  the completed `commandId` when applicable.
- `POST /api/manager/labor/import` receives multipart Timesheet `file`,
  `notesFile`, `notesScope=daily_timesheet`, `source=supercrew`
  and the requested `periodStart` / `periodEnd`. It returns import/duplicate
  status. The importer validates that the workbook's own period matches the
  requested dates and that its source filters cover all jobs, workers and types.
  Notes rows must match the verified daily scope and declared dates. Both reports
  are parsed before atomic activation; a failure leaves the earlier snapshot
  active. Worker notes-only or Timesheet-only uploads are rejected.

Overlapping exports are source snapshots, not additive payroll batches. The
application importer handles duplicate detection and updated source facts. A
later correction can appear within the rolling window; older corrections still
need an explicit historical import.

The worker must remain running for automatic downloads to happen. Closing the
development server or worker stops the workflow. No hosted worker, production
schedule or OS background service is installed by this development change.

## Private files and validation

`.local/labor-worker/` must be ignored by Git. Directories use mode `0700`; local
reports/state use `0600`. It holds the isolated profile, original reports,
scheduler state and process lock. Authentication artifacts are sensitive and
must not be included in commits, support screenshots or routine logs. Signed
report URLs are redacted from errors.

Run the focused tests with:

```sh
npm run test:labor-worker
```

These tests use local mocks: DST and catch-up scheduling, unconnected-state
preservation, upcoming run timestamps, local-only destinations,
token-authenticated upload, source filter clearing, calendar verification,
download-origin restrictions and native download handling.

On October 1, the saved isolated session downloaded a real September 17–30
Timesheet and daily Notes pair. The app's **Download now** action then completed
another full worker run and atomic importer acceptance: 812 entries, 9 workers
and 16 daily comments, with success recorded at 4:49 p.m. Eastern. The actual
Timesheet contains an edited `NoGPS` capture method on a named job entry; the
parser preserves this observed method and emits an evidence warning. Unknown
methods and conflicting travel/break evidence remain rejected. The published
648.25-hour report total and 648.27-hour signed entry total are preserved
separately, and both original workbooks are retained unchanged.

The development web server and watch worker remain running, with the next
scheduled run reported as October 2 at 6 a.m. Eastern. A future scheduled run
has not yet occurred. Automatic downloads depend on those local processes and
the machine staying available.

Implementation references: [Playwright downloads](https://playwright.dev/docs/api/class-download)
and [authentication guidance](https://playwright.dev/docs/auth).
