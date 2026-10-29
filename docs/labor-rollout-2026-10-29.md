# Labor Hours and Jobs rollout — October 29, 2026

The release combines the shared labor implementation with the receipt reliability, credit/debit, material-type, ten-page, stable catalog pagination and Updates changes already deployed on October 29. Labor uses the same active manager/admin accounts as receipts. Real exports require a current job-specific approval and a separate Send confirmation.

## Completed acceptance

- Configurable daily, weekly, biweekly (14 days) and custom 1–365-day downloads. Saving preserves a paused schedule. Calendar scheduling handles daylight-saving changes and retains overdue timestamps.
- Shared worker coverage follows verified paired Timesheet/Notes imports. Longer gaps download in resumable batches of at most 31 completed days. Committed batches survive interrupted worker completion; failed attempts wait for a fresh request or the next interval. Paused manual runs display remaining dates.
- Manager role recheck after database locks; worker operations cannot modify pay/rules/job links/recurrence. Immutable originals, exact frozen approvals, duplicate source-interval reservations and read-only uncertain-send reconciliation remain enforced.
- Manager-gated signed original downloads and streamed dashboard/CSV responses avoid the host's buffered response limit.
- Manual resolutions retain manager evidence without changing Housecall, claiming provider verification, releasing reservations or enabling another send.
- Live acceptance on the user-nominated Housecall job appended exactly one zero-cost synthetic material, verified exact readback, preserved the preexisting material and rejected a repeated send. See [Housecall safety](labor-housecall-safety.md). No real crew hours were posted.

All eight labor migrations were applied explicitly to production after a clean local replay and 24 rollback SQL suites. Separate-connection tests covered ledger races, manager disable/demotion while waiting, approval overlap and lease expiry. Existing production receipt migration timestamps differ from repository filenames; do not run a blind broad database push.

The fresh staging snapshot at revision 42 transferred 10 Timesheet and 9 Notes imports, 19 original workbooks (1,096,720 bytes), and 2,716 current winning entries. Every original SHA-256 was checked before and after transfer. Existing rules, pay settings and eight historical date-scoped links were preserved exactly. No staging Auth users, export approvals or worker session credentials were copied. The target was empty, initialization left downloads paused/disconnected, and the private frozen snapshot is available for recovery. Coverage is verified through 2026-10-28.

The pre-migration storage-monitor function, grants, object counts and exact migration hashes are preserved privately. Hosted PITR availability was not independently established; these changes are additive, and recovery for labor uses the frozen snapshot and originals without dropping receipt data.

## Production connection and release record

Initial configuration enables Labor Hours and Jobs with manual labor sending confined to the nominated test job during acceptance. A new private worker token and separate session encryption key are configured in GitHub Actions; the server receives only its worker token. Existing receipt credentials/settings are preserved.

Production Supercrew connection, a real paired hosted import, final deployment/commit identity and recurring workflow acceptance will be recorded here as they complete. The hourly workflow checks for due/requested work; it does not send hours to Housecall. Immediate GitHub dispatch is optional and requires a separate narrowly scoped Actions credential. Without it, Queue download waits for a hosted worker check.

The existing estimate policy remains proportional daily lunch and chronological overtime after 40 paid hours in the saved Thursday–Wednesday week. The provider item is one Materials cost summary per approved job/period, with exact cents and worker/hour details in its description. Actual job mapping remains a manager decision; previously unconfirmed destinations are not inferred.

## Recovery

Pause downloads in Labor Hours or set LABOR_ENABLED=0 to hide the feature while preserving data. Disable manual sends with LABOR_HOUSECALL_SEND_ENABLED=0. Keep production originals, approved snapshots, reservations and audit history. Never replay an uncertain send: use Verify existing send and, when a human corrects Housecall, record the manual resolution evidence.
