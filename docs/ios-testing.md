# iOS testing on this Mac

Setup verified on September 11, 2026, against commit `58cbab1` plus the local iOS setup changes.

## Installed tools

- Apple Silicon Mac, macOS 26.5.1.
- Xcode 26.6, build 17F113; first-launch setup complete.
- Active developer directory: `/Applications/Xcode.app/Contents/Developer`.
- iOS 26.5 simulator runtime; iPhone 17 selected for native checks.
- CocoaPods 1.17.0 installed through Homebrew, with its Ruby dependency.
- Existing Node 25.8.1, npm 11.11.0, and Watchman.
- Playwright WebKit 26.5, build 2336.

## Project configuration

The iOS bundle identifier is `com.visionarylabs.svlreceipts`, matching the Android application identifier. This does not register the app with Apple or create distribution credentials.

This checkout has spaces in its path. Expo's Constants build phase and generated React Native bundling phase executed unquoted paths, preventing the first native build. The fix is retained in:

- `patches/expo-constants+57.0.16.patch`: quote the script invocation, explicit project root and `basename` operand.
- `apps/mobile/plugins/with-ios-path-quoting.js`: quote the generated bundling command on iOS prebuild.

The existing mobile postinstall applies the patches. The patch changes only the two Expo Constants source files; it contains no Android build artifacts. Both patches applied successfully with `npx patch-package --error-on-fail`. The generated bundling command also passed a direct execution check from this checkout.

Related upstream issue: [Expo iOS builds in paths with spaces](https://github.com/expo/expo/issues/48705).

## Website checks

Run from the repository root:

```sh
npx playwright test --config apps/web/playwright.webkit.config.ts
```

All **78 checks passed**: the existing 39 scenarios under each of the desktop Safari and iPhone WebKit configurations. These cover navigation, filters, receipt review, drafts, approvals, recovery, image controls, small layouts, and server access guards using local synthetic fixtures. Some scenarios explicitly select their own viewport dimensions. These checks are not live Housecall writes or physical-iPhone acceptance.

The deployed manager website's sign-in page was also opened and visually inspected in Safari inside the iPhone 17 simulator. No live account was signed in for that check.

Mobile/web TypeScript checks and formatting checks for the changed configuration passed.

## Native simulator checks

The native app built successfully with zero errors and two warnings, was installed on the iPhone 17 simulator, and opened to its sign-in screen. Build evidence is in the ignored `.local/ra6/ios-build.log` file on this Mac.

The initial environment-variable overrides did not establish an isolated native test run. For the later resilience checks, `apps/mobile/.env.local` was temporarily replaced with loopback-only fixture settings and Metro restarted with a cleared cache. Native authentication, API, JPEG upload and confirmation requests were verified in the local service's event log before counting any fixture results. The original hosted configuration was restored byte-for-byte afterward.

Manual app testing was handed to the user. During sign-in diagnosis, the simulator's Supabase and `/api/me` destinations were confirmed to match that configuration. Separate API checks using the existing active worker and reported manager test accounts successfully authenticated, read their active profiles, and received HTTP 200 with valid identities from the hosted `/api/me` endpoint.

The simulator had received an inactive-account response for the active manager session earlier. Rechecking the same session returned the correct manager identity; the original cause of the earlier response was not established. After restarting Metro with the normal `.env.local` configuration and refreshing the app, the simulator correctly showed the active manager's email and the message directing managers to the website. The mobile identity request now asks caches to bypass stored responses, and the blocked screen shows the signed-in email with a retry action for inactive results. Thirteen existing authentication tests, mobile TypeScript validation, and formatting checks for these changes passed. No roles or activation settings were changed.

For further manual testing, Metro runs from `apps/mobile` with `npm run start -- --dev-client --port 8085`. Use an active worker account for native receipt capture; active managers and admins use the website.

The user subsequently uploaded an existing synthetic Purshottam-job receipt in the iOS simulator and reported seeing it on the manager website. A read-only API check confirmed the new one-page submission with an `in_review` worker status and a successful readability result. Its full image and status were subsequently opened successfully in the native receipt-detail screen. Actual camera capture quality remains unverified.

The user also reported that Recent uploads showed a cloud error. The live API returned HTTP 200 with nine records: the new submission plus eight older records with zero available confirmed photo pages. The mobile history parser required at least one page for every record and rejected the entire response. The fix permits zero-page history entries, labels them “Receipt photos unavailable,” and keeps their unavailable photo-detail links disabled. Upload and receipt-detail validation are unchanged.

A regression test reproduced the mixed-history failure before the fix. All 12 response-parser/history tests then passed, along with mobile TypeScript and formatting checks. The fixed parser accepted all nine records from the live API. After refreshing the simulator, Recent visibly showed the new submission's thumbnail and In review status, older records with the missing-photo label, and no cloud-error banner. The app was left on that screen for the user to continue testing. No receipts were modified or approved during this diagnosis.

## Remaining Mac checklist — completed September 11

These checks used the native iPhone 17 simulator app. Network failures and reviewer outcomes were deliberately simulated by a loopback-only service; they do not represent a new hosted Housecall export or approval acceptance run.

| Check | Observed result |
| --- | --- |
| Multiple-page selection and limit | Five visibly synthetic images selected; picker and preview enforced the five-page limit. |
| Preview editing | Zoom/reset and clockwise rotation worked. Removing pages updated the count from five to two. Replacing page one preserved page two and restored the selected replacement image. |
| Interrupted two-page upload | The service stored page one, then dropped page two's connection. The app showed Failed, kept both pages queued, and did not claim Sent. |
| Restart while unreachable | The app process was terminated and relaunched with the receipt service unreachable. Cached sign-in worked and Recent showed the saved two-page upload and its preview. |
| Automatic recovery | After connectivity returned, the app uploaded only the missing second page and confirmed one receipt. Page one had one PUT total; page two had two attempts, including the deliberately failed attempt. |
| Lost confirmation response | The service saved another one-page receipt, then dropped its confirmation response. The app showed a retryable failure. Manual retry reached Sent with one logical receipt confirmation, two confirmation requests, and only one image PUT. |
| Permissions and cancellation | Camera permission was disabled through iOS Settings. The app showed recovery controls; the gallery could be cancelled, reopened and used successfully. Denied location access showed a clear message and allowed submission without location. Granted location access also produced a sample. |
| Permission restoration | Open settings reached the app's settings. Camera was restored to enabled; location was restored to Ask Next Time Or When I Share. Camera controls returned after reopening the app. |
| Review results and details | Local Approved and Needs retake results appeared in Recent, including page-specific guidance. The recovered two-page receipt opened with its updated status and both page entries. |
| Detail navigation | Found and fixed the missing visible return control in the nested iOS receipt-detail stack. The new Back to recent uploads button returned to Recent successfully. |
| Simulated notifications | An iOS notification banner appeared. Tapping it opened and highlighted the corresponding retake entry with the app backgrounded and with its process fully terminated. This used `simctl push`, not production APNs delivery. |
| Retake entry | The notification-linked Retake action opened the capture/recovery flow. |
| Sign-out and account separation | Sign-out returned to login. A second local worker saw an empty history rather than the first worker's receipts; the second worker was then signed out. |

All **125 mobile unit tests across 23 files** passed, along with mobile TypeScript validation and formatting checks for the navigation fix. This supplements the earlier 78 passing website WebKit scenarios. No hosted receipt statuses, account roles or activation settings were changed by these resilience tests.

Local execution evidence is retained in ignored `.local/ra6/ios-mac-checks-results.json`, `ios-mac-checks-events.ndjson`, `ios-after-interruption.json`, `ios-after-recovery.json`, `ios-after-confirmation-retry.json`, `ios-mac-final-evidence.json`, and `ios-mobile-tests.log`. The local service is `ios-mac-fixture.mjs`; its two synthetic receipts lived in memory and the service was stopped after testing.

## Remaining physical-device acceptance

The remaining Mac checklist is complete. Simulator results do not establish real receipt-camera focus and image quality, physical photo-library/HEIC behavior, actual cellular and locked-phone behavior, signed iPhone installation, or production Apple push delivery. Hosted receipt-processing/export acceptance remains separate from the local failure-injection results above.
