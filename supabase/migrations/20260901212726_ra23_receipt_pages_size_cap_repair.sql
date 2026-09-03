-- Repair environments where the already-applied RA-23 migration was recorded
-- before the 10 MiB upper bound was added to the checked-in migration file.
--
-- Add and validate the replacement before removing the weaker constraint so
-- there is never a window where new writes lose byte-size validation.

alter table public.receipt_pages
  add constraint receipt_pages_byte_size_limit_repair_check check (
    byte_size is null or (byte_size > 0 and byte_size <= 10485760)
  ) not valid;

alter table public.receipt_pages
  validate constraint receipt_pages_byte_size_limit_repair_check;

alter table public.receipt_pages
  drop constraint receipt_pages_byte_size_check;

alter table public.receipt_pages
  rename constraint receipt_pages_byte_size_limit_repair_check
  to receipt_pages_byte_size_check;
