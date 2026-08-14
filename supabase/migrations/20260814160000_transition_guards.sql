-- RA-84: a succeeded Housecall step must never be recorded twice for the same
-- target. Receipt status edges and actor/timestamp checks live in @svl/domain
-- (`evaluateReceiptTransition`, `evaluateHousecallStepAttempt`).

create unique index export_attempts_succeeded_attachment_uidx
  on public.export_attempts (receipt_id, housecall_job_id)
  where status = 'succeeded' and step = 'attachment';

create unique index export_attempts_succeeded_job_cost_uidx
  on public.export_attempts (receipt_id, receipt_line_id, housecall_job_id)
  where status = 'succeeded' and step = 'job_cost';
