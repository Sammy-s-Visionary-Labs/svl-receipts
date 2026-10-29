# Mac mini production worker

The Mac mini runs the shared `hosted.mjs --watch` protocol against the production
receipt app. The app owns the schedule, missing-date coverage, and import lease.
The Mac must be powered on, awake, online, and logged into the installing user's
desktop session. A LaunchAgent starts it after login and restarts an unexpected
process exit, with a 60-second launch throttle. This does not change FileVault,
automatic login, sleep settings, or system power settings.

When the Mac returns after missing a schedule, its first check finds overdue
work in the shared database. It imports all missing completed dates, in batches
of at most 31 days, plus the configured recent correction window. If power was
lost during acquisition, the expired lease is recovered; a fresh claim retries
only the pending chunk after a 60-second delay. Already committed chunks stay
recorded. Paused schedules stay paused, and a missing or expired Supercrew login
requires normal reconnection. This worker never sends labor to Housecall.

## Prepare and review

Use a private `0600` environment file at
`.local/verification/labor-production-worker.env` containing only these five
settings: `LABOR_APP_URL`, `LABOR_APP_HOST`, `LABOR_WORKER_TOKEN`,
`LABOR_SESSION_ENCRYPTION_KEY`, and `SUPERCREW_REPORT_DOWNLOADS_APPROVED=1`.
The URL must be the exact HTTPS production origin and its hostname must match.
The production token and session encryption key are separate from development.
Neither credentials nor existing browser profiles enter the prepared bundle.

From the repository root:

```sh
node scripts/supercrew-worker/install-mac-agent.mjs \
  --prepare .local/verification/mac-worker-install \
  --env-file .local/verification/labor-production-worker.env \
  --origin https://svl-receipts-web.vercel.app \
  --node /opt/homebrew/bin/node \
  --npm-cli /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js
```

Preparation writes only the requested workspace directory. Review its `plan.json`,
file hashes, and `com.svl.labor-worker.plist`. Node and npm paths must exist on the
target Mac; an absolute stable Node path avoids login-shell PATH dependencies.
The release name is a hash of the copied worker files and package lockfile.

Set GitHub repository variable `LABOR_WORKER_HOST` to `mac`. The cloud workflow
is gated by the exact value `github`, so it cannot acquire production work while
the Mac is selected. The shared lease also prevents concurrent imports.

## Install, connect, and start

Install the reviewed bundle explicitly:

```sh
node scripts/supercrew-worker/install-mac-agent.mjs \
  --install .local/verification/mac-worker-install \
  --env-file .local/verification/labor-production-worker.env
```

Installation creates `~/Library/Application Support/SVL Labor Worker/` with
private permissions. It installs locked npm dependencies and matching Chromium
inside a versioned release, performs an offline browser startup check, writes
the protected production environment and LaunchAgent plist, and leaves the
service stopped. It copies no development session, `.local` folder, or website
credentials. Runtime state lives in the installation's separate `runtime/`
directory, so editing or removing the checkout does not change the running code.
An already loaded service must be booted out before installation or reconnection.

Run normal isolated Supercrew sign-in from the pinned release:

```sh
worker_root="$HOME/Library/Application Support/SVL Labor Worker"
worker_release="$(/opt/homebrew/bin/node -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).releaseDirectory" \
  "$worker_root/installation.json")"
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 \
  PLAYWRIGHT_BROWSERS_PATH="$worker_release/browsers" \
  /opt/homebrew/bin/node "$worker_release/mac-service.mjs" \
  --config "$worker_root/production.env" --runtime "$worker_root/runtime" --connect
```

The operator enters credentials and MFA in the isolated browser. Each connection
uses a new private profile, verifies the expected company and a fresh portable
browser session, publishes encrypted state, and removes that temporary profile.
It downloads no reports. After connection succeeds:

```sh
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.svl.labor-worker.plist"
launchctl print "gui/$(id -u)/com.svl.labor-worker"
```

The worker now polls for server-authorized work. Starting it does not enable a
paused schedule. A previously queued manual request can start immediately.
Enable the desired recurrence in Labor Hours when ready.

## Stop, reconnect, and inspect

Stop the watcher before reconnecting, so its lifetime profile lock is released:

```sh
launchctl bootout "gui/$(id -u)/com.svl.labor-worker"
```

Then run the connection command above and bootstrap the agent again. Booting out
stops this session's agent; its installed plist loads again at the next login.
Use **Pause downloads** in the app when automatic acquisition should remain off.
Never copy another browser profile or remove a live worker lock to reconnect.

`runtime/service.log` and its single `.1` backup contain only fixed status
messages, each capped at 1 MiB with `0600` permissions. Credentials, source rows,
provider errors, and signed report links are excluded. Detailed acquisition
errors and import history remain in the manager app. Private downloaded originals
are retained in `runtime/.local/labor-worker/reports`; the app also stores its
committed originals durably. Keep these files out of source control and support
attachments. Service restart and missed-date tests use synthetic data and do not
establish successful live production acquisition.
