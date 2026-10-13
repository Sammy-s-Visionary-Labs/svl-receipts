// Synthetic acceptance on a fresh disposable loopback database. Never HTTP.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.SVL_APPLIED_DATABASE_URL;
if (!url || process.env.SVL_LABOR_APPROVAL_QA !== "isolated-disposable")
  throw new Error("Explicit isolated disposable approval QA confirmation is required");
const parsed = new URL(url);
const freshGitHubRunner =
  process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true" && parsed.port === "54322";
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
  (Number(parsed.port) < 55550 && !freshGitHubRunner)
)
  throw new Error("Approval concurrency tests require a dedicated loopback QA database");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const admin = postgres(url, {
  max: 1,
  prepare: false,
  connection: { application_name: "labor_approval_qa_admin" },
});
const first = postgres(url, {
  max: 1,
  prepare: false,
  connection: { application_name: "labor_approval_qa_first" },
});
const second = postgres(url, {
  max: 1,
  prepare: false,
  connection: { application_name: "labor_approval_qa_second" },
});
const manager = "93000000-0000-4000-8000-000000000001";
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function lockObserved() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] =
      await admin`select exists(select 1 from pg_stat_activity where application_name='labor_approval_qa_second' and wait_event_type='Lock') as waiting`;
    if (row.waiting) return;
    await pause(25);
  }
  throw new Error("Expected real database lock wait was not observed");
}
async function snapshot(row) {
  const [result] = await admin`select pg_temp.snapshot(${row}) as value`;
  return result.value;
}
async function approve(client, value, revision) {
  const [result] =
    await client`select public.approve_labor_job_hours(${client.json(value)},${canonical(value)},${hash(value)},${revision},${manager}) as value`;
  return result.value;
}
async function race(firstOperation, secondOperation, holdMs = 0) {
  let release;
  let ready;
  let failed;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const one = first.begin(async (tx) => {
    await tx`set local role service_role`;
    const value = await firstOperation(tx);
    ready();
    await held;
    return value;
  });
  one.catch(failed);
  await started;
  const two = second
    .begin(async (tx) => {
      await tx`set local role service_role`;
      return await secondOperation(tx);
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await lockObserved();
    if (holdMs) await pause(holdMs);
  } finally {
    release();
  }
  return [await one, await two];
}

try {
  const [initial] =
    await admin`select revision,control,(select count(*) from public.labor_job_hour_approvals) as approvals from public.labor_state where singleton`;
  check(initial.revision === "0" || initial.revision === 0, "QA ledger must be fresh");
  check(
    initial.control === null && Number(initial.approvals) === 0,
    "QA project already contains labor records",
  );
  const fixture = await readFile(join(root, "supabase/tests/labor_approval_applied.sql"), "utf8");
  await admin.unsafe(`${fixture.slice(0, fixture.indexOf("do $$ declare tab"))}\ncommit;`).simple();

  const source = await snapshot(7);
  const overlapping = { ...source, toDate: "2026-09-19" };
  const [, rejected] = await race(
    (tx) => approve(tx, source, 1),
    (tx) => approve(tx, overlapping, 1),
  );
  check(
    rejected.error?.message === "labor_approval_duplicate_interval",
    "Concurrent overlapping approval was not rejected",
  );
  const [count] =
    await admin`select count(*) as count from public.labor_job_hour_reservations where released_at is null and worker_name_key='test 7 worker'`;
  check(Number(count.count) === 1, "Concurrent approval duplicated reservations");

  const row8 = await snapshot(8);
  const approved8 = await approve(admin, row8, 1);
  const [attempt8] =
    await admin`insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision,created_at,expires_at) values(${approved8.id},${manager},1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '500 milliseconds') returning id,lease_token`;
  await admin`update public.labor_job_hour_approvals set status='sending' where id=${approved8.id}`;
  const [, expired] = await race(
    async (tx) => {
      await tx`select 1 from public.labor_state where singleton for update`;
    },
    async (tx) => {
      const [row] =
        await tx`select public.mark_labor_job_hour_dispatched(${approved8.id},${attempt8.id},${attempt8.lease_token}) as value`;
      return row.value;
    },
    650,
  );
  check(
    !expired.error && expired.value.allowed === false && expired.value.approval.status === "failed",
    "Lease expiry during ledger wait authorized dispatch",
  );

  const row9 = await snapshot(9);
  const approved9 = await approve(admin, row9, 1);
  const [claim9] =
    await admin`select public.claim_labor_job_hour_send(${approved9.id},${approved9.snapshot_hash},1,${manager}) as value`;
  const [, changed] = await race(
    async (tx) => {
      await tx`update public.labor_state set revision=revision+1 where singleton`;
    },
    async (tx) => {
      const attempt = claim9.value.attempt;
      const [row] =
        await tx`select public.mark_labor_job_hour_dispatched(${approved9.id},${attempt.id},${attempt.lease_token}) as value`;
      return row.value;
    },
  );
  check(
    !changed.error && changed.value.allowed === false && changed.value.approval.status === "stale",
    "Source change during ledger wait authorized dispatch",
  );
  const [reservation9] =
    await admin`select count(*) as count from public.labor_job_hour_reservations where approval_id=${approved9.id} and released_at is null`;
  check(
    Number(reservation9.count) === 0,
    "Stale undispatched approval did not release reservations",
  );

  const row10 = await snapshot(10);
  const approved10 = await approve(admin, row10, 2);
  const [, doubleClaim] = await race(
    async (tx) => {
      const [row] =
        await tx`select public.claim_labor_job_hour_send(${approved10.id},${approved10.snapshot_hash},2,${manager}) as value`;
      return row.value;
    },
    async (tx) => {
      const [row] =
        await tx`select public.claim_labor_job_hour_send(${approved10.id},${approved10.snapshot_hash},2,${manager}) as value`;
      return row.value;
    },
  );
  check(
    doubleClaim.error?.message === "labor_approval_invalid_status",
    "Concurrent send claim was not rejected",
  );
  const [attemptCount] =
    await admin`select count(*) as count from public.labor_job_hour_attempts where approval_id=${approved10.id}`;
  check(Number(attemptCount.count) === 1, "Concurrent send created duplicate attempts");
  const row11 = await snapshot(11);
  const approved11 = await approve(admin, row11, 2);
  const [attempt11] =
    await admin`insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision,created_at,expires_at) values(${approved11.id},${manager},2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '500 milliseconds') returning id,lease_token`;
  await admin`update public.labor_job_hour_approvals set status='sending' where id=${approved11.id}`;
  const [, expiredAtAttempt] = await race(
    async (tx) => {
      await tx`select 1 from public.labor_job_hour_attempts where id=${attempt11.id} for update`;
    },
    async (tx) => {
      const [row] =
        await tx`select public.mark_labor_job_hour_dispatched(${approved11.id},${attempt11.id},${attempt11.lease_token}) as value`;
      return row.value;
    },
    650,
  );
  check(
    !expiredAtAttempt.error &&
      expiredAtAttempt.value.allowed === false &&
      expiredAtAttempt.value.approval.status === "failed",
    "Lease expiry during attempt-row wait authorized dispatch",
  );
  await admin`update public.labor_source_imports i set report=jsonb_set(i.report,'{entries}',(select jsonb_agg(case when e->>'id'='TEST_ROW_12' then e||jsonb_build_object('hours',0.01,'clockOut','08:00') else e end)from jsonb_array_elements(i.report->'entries')e))where i.id='93000000-0000-4000-8000-000000000010'`;
  const point = await snapshot(12);
  point.totalHourHundredths = 1;
  point.entries[0].endMinute = point.entries[0].startMinute;
  point.entries[0].hourHundredths = 1;
  point.entries[0].reviewReasons = [
    "Positive source Hours have same-minute exported clocks; original Hours and clock strings were preserved.",
  ];
  for (const field of ["paidHourHundredths", "regularHourHundredths"]) {
    point.costEstimate[field] = 1;
    point.costEstimate.workers[0][field] = 1;
  }
  point.costEstimate.workers[0].sourceHourHundredths = 1;
  point.costEstimate.totalCostCents = 20;
  point.costEstimate.workers[0].totalCostCents = 20;
  point.providerIntent.preparedWrite.body.job_input_materials[0].unit_cost = 20;
  for (const field of ["grossHours", "sourceNetHours", "netHours", "allocatedHours"])
    point.workerDays[0][field] = 0.01;
  const [, pointConflict] = await race(
    (tx) => approve(tx, point, 2),
    (tx) => approve(tx, { ...point, toDate: "2026-09-19" }, 2),
  );
  check(
    pointConflict.error?.message === "labor_approval_duplicate_interval",
    "Concurrent same-minute point approval duplicated source hours",
  );
  console.log(
    JSON.stringify({
      concurrentOverlappingApproval: "passed",
      leaseExpiryAfterLockWait: "passed",
      sourceChangeAfterLockWait: "passed",
      concurrentManualSendClaims: "passed",
      leaseExpiryAfterAttemptLockWait: "passed",
      concurrentSameMinutePointApproval: "passed",
      providerCalls: 0,
      database: "isolated-loopback",
    }),
  );
} finally {
  await Promise.all([
    admin.end({ timeout: 5 }),
    first.end({ timeout: 5 }),
    second.end({ timeout: 5 }),
  ]);
}
