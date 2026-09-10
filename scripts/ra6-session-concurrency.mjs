/** Concurrent manager approvals must share one immutable test-session budget.
 * Uses only an explicitly local database; no provider is called.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const rawUrl = process.env.SVL_APPLIED_DATABASE_URL;
if (!rawUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(rawUrl).hostname)) {
  throw new Error("Session concurrency tests require an explicit loopback database");
}
const sql = postgres(rawUrl, { max: 3, prepare: false });
const owner = randomUUID();
const admin = randomUUID();
const receipts = [randomUUID(), randomUUID()];
const marker = `ra6-session-${randomUUID()}`;
let sessionId;
let release = () => {};
try {
  await sql.begin(async (tx) => {
    await tx`insert into auth.users(id,aud,role,email) values (${owner},'authenticated','authenticated',${`${owner}@example.invalid`}),(${admin},'authenticated','authenticated',${`${admin}@example.invalid`})`;
    await tx`update public.profiles set role='admin' where id=${admin}`;
    await tx`insert into public.receipt_categories(id,label) values (${marker},${marker})`;
    await tx`insert into public.manager_job_catalog(id,label,source,customer_id,synced_at) values (${marker},'Synthetic session job','housecall',${marker},clock_timestamp())`;
    const [session] =
      await tx`select public.create_housecall_test_session(${admin},array[${owner}]::uuid[],array[${admin}]::uuid[],${tx.json({ [marker]: marker })},clock_timestamp()+interval '1 hour',1,2,2100,2100,'Local concurrency test') as id`;
    sessionId = session.id;
    for (const id of receipts) {
      await tx`insert into public.receipts(id,owner_user_id,status,created_at,submitted_at) values (${id},${owner},'needs_review',clock_timestamp(),clock_timestamp())`;
      await tx`insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at) values (${id},0,${`${marker}/${id}.jpg`},'image/jpeg',${"a".repeat(64)},100,clock_timestamp())`;
    }
  });
  const snapshot = {
    vendor: "SYNTHETIC SESSION TEST",
    purchaseDate: "2026-09-10",
    category: marker,
    invoiceNumber: marker,
    ticketNumber: "",
    referenceTotal: "21.00",
    managerNotes: "",
    lines: [
      {
        description: "Synthetic material",
        qty: "0.5",
        uom: "ton",
        unitCost: "42.00",
        jobId: marker,
      },
    ],
  };
  let report;
  const ready = new Promise((resolve) => {
    report = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    const [row] =
      await tx`select public.manager_review_with_test_export(${sessionId},${receipts[0]},${admin},0,null,'approve',${tx.json(snapshot)}) as result`;
    assert.equal(row.result.exportAuthorized, true);
    report({ ok: true });
    await hold;
  });
  first.catch((error) => report({ error }));
  const firstResult = await ready;
  if (firstResult.error) throw firstResult.error;
  const second = sql
    .begin(async (tx) => {
      await tx`select set_config('application_name',${marker},true)`;
      await tx`set local role service_role`;
      await tx`select public.manager_review_with_test_export(${sessionId},${receipts[1]},${admin},0,null,'approve',${tx.json(snapshot)})`;
      return "unexpected_approval";
    })
    .catch((error) => error.message);
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const [state] =
        await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked`;
      if (state.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(blocked, true, "second approval did not wait for the shared session");
  } finally {
    release();
  }
  await first;
  assert.equal(await second, "test_export_budget");
  const [session] =
    await sql`select reserved_receipts,reserved_writes,reserved_cents from public.housecall_test_sessions where id=${sessionId}`;
  assert.deepEqual(session, { reserved_receipts: 1, reserved_writes: 2, reserved_cents: 2100 });
  const [rejected] =
    await sql`select status,review_version from public.receipts where id=${receipts[1]}`;
  assert.deepEqual(rejected, { status: "needs_review", review_version: 0 });
  const [grants] =
    await sql`select count(*)::int as count from public.housecall_write_approvals where test_session_id=${sessionId}`;
  assert.equal(grants.count, 1);
  console.log("Concurrent approvals preserved the shared budget; rejected approval rolled back.");
} finally {
  release();
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('svl.allow_purge','true',true)`;
      await tx`delete from public.receipts where id=any(${receipts}::uuid[])`;
      if (sessionId) await tx`delete from public.housecall_test_sessions where id=${sessionId}`;
      await tx`delete from public.manager_job_catalog where id=${marker}`;
      await tx`delete from public.receipt_categories where id=${marker}`;
      await tx`delete from auth.users where id=any(${[owner, admin]}::uuid[])`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
