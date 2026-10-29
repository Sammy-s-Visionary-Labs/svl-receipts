# Hosted Supercrew worker

The GitHub workflow checks the receipt app each hour at minute 17 UTC. An idle check uses Node built-ins and exits before installing npm packages or Chromium. When the app grants a command, one finite Linux job exports Timesheet and Daily Timesheet Notes for the same claimed period of at most 31 completed dates, imports both originals together, refreshes its encrypted login state, and finishes its lease. The current date is excluded using the app's configured time zone.

This option uses the existing GitHub, Vercel and Supabase accounts. It requires no additional paid service. The current repository is public: [standard GitHub-hosted runners are free for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), including the workflow's `ubuntu-latest` runner. If the repository becomes private, its included Actions minutes become shared with the account's other workflows; prevent paid overage through account usage limits. GitHub can delay scheduled runs, so the app catches up after the configured local hour. Scheduled workflows must be on the repository's default branch. An explicit Download now request stays queued for the next hourly check when immediate workflow dispatch is not configured.

## Deployment configuration

Deploy the shared labor database/storage migrations and the worker endpoints before enabling the workflow. Enable labor in the deployed app and review its migration acceptance results. Manager/admin users use their existing receipt-app accounts; the worker uses a separate machine credential.

Set these GitHub repository variables:

- `LABOR_APP_URL`: the receipt app's production HTTPS origin, with no path, query or nondefault port.
- `LABOR_APP_HOST`: its exact hostname, matching the URL. Redirects are rejected.

Set these repository secrets through GitHub's secret settings:

- `LABOR_WORKER_TOKEN`: at least 32 characters, matching the dedicated token configured on the receipt app server.
- `LABOR_SESSION_ENCRYPTION_KEY`: 32 random bytes represented by exactly 64 hexadecimal characters. Keep this key only in GitHub secrets and the operator's protected local setup environment. It does not belong in Vercel, the database, logs, or a committed file.

Never use the Supabase service-role key as the worker token. The worker only receives claim/heartbeat/finish/session access and paired import access. Cloud storage holds an opaque authenticated AES-256-GCM envelope; the app cannot decrypt the source session. Cookies, local storage and IndexedDB are portable, versioned inside that envelope. The encrypted envelope has a 1 MiB limit and optimistic version checks.

An optional app-side GitHub token with access limited to dispatching this repository's workflow can make Download now start sooner. Without it, queued requests are serviced by the hourly gate. Configure that token only on the server. The workflow itself has only read access to repository contents.

## Recurrence and missed dates

Managers choose daily, weekly, biweekly (14 days), or a custom interval of 1–365
calendar days in Labor Hours. **Save schedule** preserves whether downloads are
enabled or paused. **Enable recurring downloads** saves the settings and enables
automatic work; **Pause downloads** stops automatic continuation. Older saved
settings default to daily. The start hour uses the configured time zone and
daylight-saving rules; a delayed worker retains the overdue date and catches up
when it next checks.

**Days to download** is the recent correction window, from 1–31 completed dates
(default 14). In shared mode, the server also includes missing dates after its
last verified paired-report coverage. A weekly or longer interval therefore
does not silently skip dates outside that recent window. Initial coverage is
derived only from contiguous, complete Timesheet and verified Daily Timesheet
Notes pairs; a heartbeat timestamp alone cannot establish source coverage. A
new ledger with no verified pair starts with the configured recent window.

Each claim covers at most 31 dates and keeps the existing eight-minute worker
deadline. A successful chunk advances the persisted cursor; remaining chunks
become eligible at the next hourly `:17` gate. A reported failure waits for a new
explicit request or the next configured interval, rather than retrying on every
poll. An expired acquisition lease after a crash or power loss is recovered with
a 60-second delay and a fresh claim for the pending chunk. A chunk whose import
already committed is retained; recovery advances to its remaining dates.
Successful downloads restart the interval from their local completion date;
reported failures also consume an interval.

An explicit **Queue download** works while recurring downloads are paused, but
claims only one chunk. Labor Hours shows the remaining dates and asks the manager
to enable recurring downloads or queue another chunk. A new explicit request
or a retry at the next interval extends a pending target through yesterday;
normal successful continuation keeps that target fixed. Existing completed
chunks are not replayed to resume the pending range. Older corrections before
the verified coverage and outside the recent correction window still require
an explicit historical import.

## Connect or reconnect Supercrew

An operator runs the isolated setup from a trusted computer with a display. Configure the variables and secrets above in a protected environment without pasting them into chat, shell history, logs, or files in the repository. Then, from the repository root:

```sh
npm ci --prefix scripts/supercrew-worker --ignore-scripts
cd scripts/supercrew-worker
npx --no-install playwright install chromium
cd ../..
node scripts/supercrew-worker/hosted.mjs --connect
```

Complete normal Supercrew login and any MFA in the isolated browser. Setup verifies Sammy's Visionary Landscape, captures portable state, verifies that state in a second fresh browser, reads the server's current session version, and publishes encrypted bytes. It does not download reports. Do not open this setup against a profile already in use by another worker; stop that worker first. Setup uses this checkout's private `.local/labor-worker/profile` directory. Existing ordinary browser profiles must not be copied into it.

The server places a durable connection barrier before publishing bootstrap state, so a scheduled run cannot start in the middle of the update. Successful setup marks the app connected. If setup fails after that barrier, it stays pending until the operator retries successfully. Reconnecting can replace expired state without reading old plaintext. To rotate encryption keys, pause scheduling, update the protected setup environment and GitHub secret together, reconnect normally, verify a fresh Linux run, then resume scheduling.

Before declaring production acceptance, run a real fresh Linux import using the connected session and inspect the resulting paired originals, date scope, worker/company identity and dashboard totals. Synthetic tests establish portability and control behavior; they cannot prove that Supercrew accepts a particular account's session on GitHub's IP address. If the provider requires MFA or rejects that session, the run reports `needs_login`; reconnect or use a trusted always-on host with this same finite worker protocol.

## Finite runs and recovery

The app grants at most one active 15-minute lease. The worker heartbeats every 30 seconds while Chromium is running and stops after an eight-minute operation deadline. The workflow allows 15 minutes including installation. Every import and session refresh carries the claim's command and lease identity. Expired or superseded leases cannot overwrite the ledger or newer source session. Lease recovery exposes the interruption and preserves committed dates; pending acquisition resumes through a fresh claim after a 60-second delay when recurring downloads are enabled.

Successful finish is accepted only after the paired import commits. If the import succeeds but session refresh or finish fails, the message explicitly asks the operator to inspect import history before retrying. A manual retry remains available while recurring downloads are paused. A missing/expired login leaves automatic work stopped until reconnection. Browser layout, job/worker filter, date-selection or note-scope failures stop the import rather than accepting partial report coverage.

The ephemeral job removes local state on completion. Its claim record and downloaded originals use private local permissions. Reports are saved durably by the app; the workflow does not upload reports or login data as GitHub artifacts, cache them, or print session contents. Workflow logs are public, so hosted CLI output contains generic status messages only; provider/parser error details stay in the manager-only app status. No customer names, wages, reported hours, filenames, source rows, or signed URLs are printed. Runner cancellation can bypass cleanup, so no later job reuses the runner's local directory. The server's lease expires independently of the runner.

## Verification

Run unit/contract tests from the repository root:

```sh
node --test scripts/supercrew-worker/*.test.mjs
npm run test --workspace @svl/web -- lib/labor/worker-control.test.ts app/api/manager/labor/worker/session/route.test.ts
```

The fresh-browser fixture checks company verification, cookies, local storage and IndexedDB after encryption and restoration. Every browser page request is fulfilled locally, so this fixture requires no real account or credentials:

```sh
node scripts/supercrew-worker/acceptance.mjs
```

For a synthetic Linux acceptance, build only the whitelisted worker context and run without networking. The image has no app configuration, private reports or real session state:

```sh
docker build -t svl-supercrew-worker-acceptance:local scripts/supercrew-worker
docker run --rm --network none svl-supercrew-worker-acceptance:local
```

The old `worker.mjs --watch`, `--once` and local connection interface remain available for loopback development. They support the recurrence interval but only import the recent lookback window; they do not implement shared coverage-aware catch-up and are not the production scheduling path. Hosted operation uses `hosted.mjs --preflight`, `--run` and `--abort`; the shared local supervisor uses the same server-owned claims through `hosted.mjs --watch`. Do not run a second worker beside either.

For the selected Mac mini production host, use the pinned after-login service in
[the Mac worker guide](../../docs/supercrew-worker-mac.md). The GitHub import job
runs only when repository variable `LABOR_WORKER_HOST` is exactly `github`;
selecting `mac` prevents cloud acquisition.
