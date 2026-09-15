# Worker web app

The browser alternative lives at `/field` in the existing Next.js web application. Workers use the same account and submit into the same receipt service as the native app. Managers and administrators continue to enter the existing office dashboard at `/`.

## Isolation from native releases

Implemented on `worker-web-app`, based on production-mobile preparation commit `9724084`, in its own checkout. The production release checkout stays on `codex/production-mobile-builds`.

No changes to `apps/mobile`, native manifests, Android/iOS build settings, EAS configuration, dependencies, the lockfile, shared packages, database schema, receipt lifecycle APIs, or Housecall export settings are required. There are no migrations. The web release uses the existing Vercel production configuration.

## Production release

The user authorized merging `worker-web-app` into `master` on September 15, 2026.
The public worker entry is `https://svl-receipts-web.vercel.app/field`. This release
uses the existing production Supabase configuration and requires an active
production account. The office dashboard remains at `/`.

Vercel Toolbar is disabled for both production and preview in this web project.
The app contains no deployment or development-preview labels.

After production is ready, assign the previously shared hostname
`svl-receipts-web-git-worker-web-app-svl1.vercel.app` to that production deployment.
Its production-only redirect forwards visitors to the canonical production host,
preserving their path and query. Later production releases remain reachable through
that redirect even if the old alias still points at the initial release. Retire
`worker-web-app` as a preview branch after launch: pushing another preview to that
branch can reclaim its automatic alias. Use a new branch for future previews.

Only releases from `master` use production Supabase. Other branch deployments use
development settings; no development credentials or receipts are copied to production.
The existing browser-preview hostname acts as a route to the production deployment,
not as a preview connected to the production database.

## Included

- `/field`: overview, recent statuses, and resumable drafts on this device.
- `/field/new`: camera and photo-library inputs, up to five pages, rotation/removal before sending, optional location, and explicit delivery confirmation.
- `/field/receipts`: owner-only history, filters, pagination, and refresh.
- `/field/receipts/[id]`: authoritative page list, private photos, office feedback, status, and retake guidance from the existing worker-detail API.
- `/field/help`: capture guidance, draft behavior, and iPhone Home Screen instructions.
- A scoped Home Screen manifest and generated web icons. These do not replace native app icons.
- A responsive sign-in page using the existing authentication client. Workers are redirected into `/field`; manager/admin routing is preserved.

Job matching and receipt review stay with the existing office workflow. The browser does not add another job-selection or clarification-mutation API. Workers can read office feedback and submit clearer photos when a retake is needed.

## Upload and local storage behavior

Photos are decoded and resized in the browser to a maximum 1,800-pixel long edge, converted to JPEG, and hashed with SHA-256. Photos that cannot be decoded are rejected with actionable guidance; unsupported HEIC files can be replaced with a fresh camera photo or a JPEG/PNG/WebP file. Source files are limited to 50 MB / 80 megapixels. Each prepared page respects the existing 10 MB limit.

Drafts are saved in IndexedDB under the creating account. JPEG bytes are stored as ArrayBuffers, which avoids WebKit's Blob/File serialization failure. Photo encoding occurs before opening a database transaction. Drafts from other accounts are never shown or submitted.

Sending freezes the page set before creating the remote session. Each retry retains the same submission ID and immutable checksums. Uploaded-page progress is persisted before confirmation. A lost confirmation response retries only confirmation, using the existing server idempotency checks. A duplicate-object response is accepted only provisionally; server-side checksum verification still decides whether submission succeeds.

Completed drafts lose their local photos and location. A small ID/owner tombstone prevents a stale browser tab from rewriting an already-sent draft. Web Locks prevent simultaneous send attempts from multiple tabs where supported; server idempotency and ownership checks remain authoritative.

Sign-out warns about unsent drafts and keeps them for the same account. Clearing browser storage deletes drafts. The app must be online to open, authenticate, load history, and send. An already-open capture page can prepare drafts offline. Uploads require the page to remain open; there is no background upload or web push feature in this version.

There is no service worker intercepting requests or caching authenticated office pages, receipt images, or API responses. All private images use the existing short-lived signed URLs. No privileged credentials enter the browser.

## Local sample preview

From the checkout root:

```sh
npm ci --ignore-scripts
node apps/web/e2e/preview-field.mjs
```

Open `http://127.0.0.1:3197/login?next=/field`.

Sample sign-in: `worker@example.invalid` / `fixture-only`.

The preview uses the real application and its normal authentication guards against a loopback-only synthetic auth/storage service. It never connects to a hosted database or Housecall. Test uploads stay in memory and disappear when the preview stops. Browser drafts stay local until sent or discarded. This sample account exists only in the fixture service.

For integration testing against a hosted development environment, follow the existing `docs/environments.md` instructions and use development values only. The production build uses the existing web environment configuration; no new secrets or variables are required. Serve the deployed app over HTTPS for camera, location, and cryptographic browser features. Localhost is suitable for desktop testing.

## Verification

Verified locally on September 15, 2026:

- Type checking: all four workspaces passed.
- Lint: passed with no warnings.
- Automated tests: 766 passed (125 native unit tests, 2 native production checks, 350 web tests, 178 shared-domain tests, 105 integration-adapter tests, and 6 storage-monitor tests).
- Chromium browser tests: 50 passed, including all existing manager queue and review cases.
- Safari/WebKit browser tests: 22 passed across desktop Safari and emulated iPhone Safari.
- Optimized production web build: passed.
- Native release checkout: clean at `9724084` on `codex/production-mobile-builds`. Native sources, shared packages, lockfile, database, CI, and root scripts have no differences from that commit.

```sh
npm run typecheck
npm run lint
npm test
npm run build:web
npm run test:e2e
npx playwright test --config apps/web/playwright.webkit.config.ts field.e2e.ts
```

The field browser tests cover:

- Worker entry, manager entry, cookie/bearer authentication, and manager API denial for workers.
- Actual session creation, signed storage upload, checksum confirmation, worker history, native bearer reads, and manager queue visibility using synthetic persistence.
- Two-page receipts, reload recovery, rotation/removal, and account isolation.
- Lost confirmation acknowledgements and offline recovery without duplicate receipts.
- Status filtering/pagination, expired sessions, office notes, and retake guidance.
- Password sign-in, sign-out with unsent drafts, and a stale tab after completion.
- A 390-pixel phone viewport and public manifest/icon access.

These tests exercise the actual Next.js API handlers and auth guards; persistence, AI work, and third-party services are local fixtures. They do not replace a hosted development acceptance run or a physical iPhone camera/Home Screen check. The existing manager suites protect the office workflow. Native unit tests and production-configuration checks run unchanged.

Framework references: [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps), [Supabase server-side authentication](https://supabase.com/docs/guides/auth/server-side/creating-a-client).
