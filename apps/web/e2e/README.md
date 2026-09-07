# RA-27 browser verification

Run from the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Linux CI should use `npx playwright install --with-deps chromium`. Playwright is pinned in the root development dependencies. The configuration starts and stops the Next.js development server on `127.0.0.1:3187` and a synthetic Supabase HTTP fixture on `127.0.0.1:54877`. Set `RA27_E2E_PORT` or `RA27_E2E_AUTH_PORT` to use different free ports. Existing servers are deliberately not reused.

The suite needs no real account, API key, hosted database, receipt, or Housecall connection. The child Next.js process receives only the loopback Supabase URL and dummy public/service keys. Test sessions are signed HS256 cookies for four synthetic identities. The application runs its normal proxy, cookie session lookup, server profile lookup, and manager/admin guards against the local fixture server. No test bypass or authorization branch is installed in the application.

Most browser cases intercept only the browser's queue response, providing synthetic receipt summaries, opaque pagination cursors, image responses, delays, and failures. They verify UI state, request parameters, navigation, accessibility, and recovery; they do not establish that SQL filtering or sorting is correct. The separate applied SQL suite exercises the actual queue query and permissions. The server-auth cases do not intercept queue requests: they exercise the real API and guards against the HTTP fixture, which returns an empty permitted queue.

The 17 cases cover:

- Default oldest order, all six tabs, Inbox/History navigation, required row evidence and unavailable data.
- All queue filter fields, search, sorting, page size, cursor reset, next/previous/first page, and browser Back followed by Previous.
- Loading, initial failure, empty and filtered-empty results, an emptied later page, invalid-filter reset, retry, network failure, stale results, and a superseded request.
- Thumbnail failure and refresh recovery; keyboard receipt summary, focus restoration, warnings and read-only controls.
- Session expiry/revocation; manager/admin access and settings; worker/disabled/anonymous denial through the actual server routes.
- A 390px viewport, usable filters/dialog, and no document overflow.

Screenshots with synthetic data are saved as `manager-desktop.png` and `manager-narrow.png` inside each relevant test directory under `test-results/ra27/`. Failed cases additionally retain screenshots and Playwright traces. These artifacts are ignored by Git. Test filenames end in `.e2e.ts` so the Vitest workspace suite does not discover them.

For a preinstalled browser outside Playwright's usual cache, set `PLAYWRIGHT_BROWSERS_PATH` to its cache directory. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` is also available for explicit local debugging; normal verification and CI use the Chromium revision installed for the pinned Playwright version.
