# Receipt date, job selection and review access — September 11, 2026

The manager summary now displays **Open full receipt review** as a solid green,
44-pixel-minimum link button with keyboard focus styling. It remains a navigation
action, not an approval.

## Extraction and initial job selection

Gemini prompt `ra6-receipt-v1.4` explicitly asks for faint and handwritten dates,
preserves short-year date text, and associates each material's printed or
handwritten job name with that material line. Receipt text remains untrusted data
and cannot supply Housecall IDs or instructions.

The worker uses the tenant's `RECEIPT_DATE_ORDER` (MDY by default for this U.S.
business). Supported short years expand only within twenty years before through
one year after the current year. Calendar validation remains strict. Original
printed text is retained and expanded years carry a manager verification warning.
Unclear, missing, competing or invalid dates still need review.

Job scoring `ra5-rules-v2` gives a material's own job hint precedence over global
receipt references. An untouched, editable review draft can now receive automatic
job selections from current-version suggestions with confident extracted name or
reference evidence and available, fresh Housecall catalog entries. Identity
strength must distinguish the leading candidate; schedule, GPS, worker and vendor
context cannot resolve a shared-name tie. Scores are evidence weights, not
probabilities. An explanation accompanies each selection and it remains editable.

Names on different material lines are handled independently. Shop, stock and
other general materials remain unallocated. Unlabelled lines on mixed receipts,
multiple possible destinations, low-confidence text, stale catalog entries and
older scoring versions require manager selection. Existing saved drafts,
legacy edits and exported history are preserved, including deliberately cleared
job assignments. A manager can rerun extraction on an eligible unreviewed receipt
to use the new extraction version. No autofill operation saves a review, approves
an export or calls Housecall.

## Verification

- Actual Gemini parsing of the exact stored yellow Sandman image read `7-10-26`,
  normalized it to **2026-07-10**, and selected the verified Purshottam Singh job
  from the real saved Housecall catalog. This was a read-only diagnostic: zero
  saved approvals, zero Housecall writes, and no changes to the exported receipt.
- 341 web, 178 domain, 105 integration, 111 mobile and six storage-monitor checks
  passed across the full run and corrected web rerun. Four receipt-intelligence
  fixture checks also passed.
- All 39 browser scenarios passed across the suite and corrected targeted reruns.
  Coverage includes editable autofill without a save on open, preserved manager
  selections, and a visible summary button before hover.
- Workspace typechecking, lint and the Next.js production build passed.
- No database schema or role changes were needed. This is not a new physical
  camera-to-Housecall acceptance run and does not close the operational gates in
  the earlier acceptance report.

## Installed phone and deployment

The September 10 installed Android release APK contains `assets/index.android.bundle`
and the stable hosted API address. API configuration prioritizes that compiled
cloud address. The app can submit over Wi-Fi or mobile data without USB, Metro,
or a running Mac. It requires a valid login and network access for delivery; no
new offline/background retry behavior is asserted here. The APK remains an
internal build with development signing, not a Play Store distribution release.

The RA-6 Git-branch alias had inherited preview defaults with Housecall reads and
exports disabled, while the phone's stable alias used the explicitly configured
integration deployment. RA-6-specific Preview environment overrides now keep
Gemini, the existing development database, all-job reads and manager-approved
exports together on future branch deployments. Server credentials remain
server-only sensitive environment values. Other branches and the separate
Production database/deployment are unchanged.

Use the [stable manager site](https://svl-receipts-ra6-test-svl1.vercel.app) or
[RA-6 branch site](https://svl-receipts-web-git-epic-ra-6-housecall-integratio-748124-svl1.vercel.app).
New uploads use the improved extraction. Already exported receipts are not
rewritten or re-exported by this change.
