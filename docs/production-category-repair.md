# Production receipt category repair — 2026-09-15

Production had an empty `receipt_categories` table even though the manager review
and database approval rules require an active category. The RA-5 migration had
created the schema, while the user-approved Materials, Fuel, Dump, and Misc rows
were configured only in development. See `ra5-approved-categories.json` for the
original approval and keyword configuration.

The forward migration `20260915215233_restore_approved_receipt_categories.sql`
inserts missing approved categories. Existing IDs, labels, keywords, versions,
and active/inactive decisions are preserved. It does not change receipt data,
user roles, approval requirements, or Housecall export permissions. `approved_by`
is left null for deployment-created rows; the migration records the authorization
without impersonating an application administrator.

The review form now has a **Refresh categories** button. It updates only the
category options and preserves unsaved receipt edits and job assignments. Failed
refreshes preserve the existing options and show a retryable error.

## Release verification

1. Apply the forward migration to development, then production, after checking
   pending migration history. Deploy the matching web code from `master`.
2. Check configuration in the target environment, not just migration presence:

   ```sql
   select id, label, active from public.receipt_categories order by label;
   select count(*) as active_category_count
   from public.receipt_categories where active;
   ```

   An active category count of zero blocks receipt approval and must block release
   acceptance. If all categories were deliberately deactivated, resolve that
   configuration decision rather than silently reactivating them.
3. As an active manager, open an existing pending receipt and verify that the
   Category selector shows the approved active categories. Use a separate tab
   when the existing tab contains unsaved edits. Do not approve a real receipt
   merely to verify category availability.
4. Check that the receipt review version, status, and export records did not
   change during read-only verification. Existing receipts do not need reupload
   or another Gemini extraction to select a category.

Browser regression coverage includes recovery from an empty category list,
failed refresh/retry, inactive-category exclusion, and preservation of unsaved
notes and job selections with no review write.
