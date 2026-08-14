-- RA-17: keep the receipts bucket private. Clients never get public object URLs.
-- Uploads and reads go through short-lived signed URLs created by the API (service role).
-- Do not add authenticated/anon policies on storage.objects for this bucket.

update storage.buckets
set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'receipts';
