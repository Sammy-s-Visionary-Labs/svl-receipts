-- Repair environments where the already-applied RA-23 purge function still
-- clears only latitude/longitude. The accuracy and capture-time columns must
-- be cleared in the same update or the receipt GPS constraints reject purge.

create or replace function public.purge_receipt_content(
  p_receipt_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  work_row public.work_items%rowtype;
begin
  select * into work_row
  from public.work_items
  where receipt_id = p_receipt_id
    and kind = 'purge'
  for update;

  if not found
    or work_row.status is distinct from 'leased'
    or work_row.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'conflict';
  end if;

  if rec.content_deleted_at is not null then
    return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
  end if;

  if rec.purge_claimed_at is null
    or rec.purge_claimed_by is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  if rec.retention_hold or rec.delete_after_at is null or rec.delete_after_at > now() then
    raise exception 'conflict';
  end if;

  perform set_config('svl.allow_purge', 'true', true);

  delete from public.job_candidates where receipt_id = p_receipt_id;
  delete from public.receipt_lines where receipt_id = p_receipt_id;
  delete from public.reviews where receipt_id = p_receipt_id;
  delete from public.extractions where receipt_id = p_receipt_id;

  update public.receipts
  set
    storage_key = null,
    original_filename = null,
    checksum = null,
    byte_size = null,
    content_type = null,
    gps_lat = null,
    gps_lng = null,
    gps_accuracy_meters = null,
    gps_captured_at = null,
    content_deleted_at = now(),
    purge_claimed_at = null,
    purge_claimed_by = null
  where id = p_receipt_id
  returning * into rec;

  perform public.append_audit_event(
    rec.id,
    'content_purged',
    jsonb_build_object('content_deleted', false),
    jsonb_build_object('content_deleted', true),
    jsonb_build_object('worker_id', p_worker_id),
    'worker',
    null
  );

  return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
end;
$$;

revoke all on function public.purge_receipt_content(uuid, text)
  from public, anon, authenticated;
grant execute on function public.purge_receipt_content(uuid, text)
  to service_role;
