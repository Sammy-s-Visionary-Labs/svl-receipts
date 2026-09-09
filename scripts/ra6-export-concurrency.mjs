/** Real concurrent RPC transactions against an explicitly local test database.
 * Synthetic fixtures are committed for cross-session visibility and removed in
 * finally; Housecall and hosted services are never contacted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const rawUrl = process.env.SVL_APPLIED_DATABASE_URL;
if (!rawUrl) throw new Error("SVL_APPLIED_DATABASE_URL is required");
const url = new URL(rawUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error("RA6 concurrency tests require a loopback database");
}
const sql = postgres(rawUrl, { max: 3, prepare: false });
const owner = randomUUID();
const manager = randomUUID();
const firstReceipt = randomUUID();
const secondReceipt = randomUUID();
const marker = `ra6-concurrency-${randomUUID()}`;
const job = `${marker}-job`;
const snapshot = {
  vendor: "SYNTHETIC RA6 TEST",
  purchaseDate: "2026-09-09",
  invoiceNumber: marker,
  ticketNumber: "",
  category: marker,
  referenceTotal: "21.00",
  managerNotes: "",
  lines: [
    { description: "Synthetic limestone", qty: "0.5", uom: "ton", unitCost: "42.00", jobId: job },
  ],
};
let releaseFirst = () => {};
try {
  const intents = await sql.begin(async (tx) => {
    await tx`insert into auth.users(id,aud,role,email) values (${owner},'authenticated','authenticated',${`${owner}@example.invalid`}),(${manager},'authenticated','authenticated',${`${manager}@example.invalid`})`;
    await tx`update public.profiles set role='manager' where id=${manager}`;
    await tx`insert into public.receipt_categories(id,label) values (${marker},${marker})`;
    await tx`insert into public.manager_job_catalog(id,label) values (${job},'RA6 synthetic destination')`;
    for (const id of [firstReceipt, secondReceipt]) {
      await tx`insert into public.receipts(id,owner_user_id,status,submitted_at) values (${id},${owner},'needs_review',now())`;
      await tx`insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at) values (${id},0,${`${marker}/${id}.jpg`},'image/jpeg',${"a".repeat(64)},100,now())`;
    }
    const values = [];
    for (const id of [firstReceipt, secondReceipt]) {
      const [row] =
        await tx`select public.manager_review_command(${id},${manager},0,null,'approve',${tx.json(snapshot)}) as result`;
      values.push(row.result.intentId);
    }
    return values;
  });
  let reportFirst;
  const firstReady = new Promise((resolve) => {
    reportFirst = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstTransaction = sql.begin(async (tx) => {
    const [row] =
      await tx`select public.claim_housecall_export_step(${intents[0]},'concurrent-worker-a',120) as result`;
    assert.ok(row.result?.step);
    reportFirst(row.result);
    await holdFirst;
    return row.result;
  });
  // Propagate a failed first transaction instead of waiting forever for its signal.
  firstTransaction.catch((error) => {
    reportFirst({ error });
  });
  const first = await firstReady;
  if (first.error) throw first.error;
  try {
    // A different receipt cannot see uncommitted step state. The destination
    // advisory lock must nevertheless reject this claim without a stolen lease.
    const [second] =
      await sql`select public.claim_housecall_export_step(${intents[1]},'concurrent-worker-b',120) as result`;
    assert.equal(second.result, null, "concurrent receipt stole destination before first commit");
  } finally {
    releaseFirst();
  }
  await firstTransaction;
  const [blocked] =
    await sql`select public.claim_housecall_export_step(${intents[1]},'concurrent-worker-b',120) as result`;
  assert.equal(blocked.result, null, "durable destination lease not retained after commit");
  await sql`select public.finish_housecall_export_step(${first.step.id},${first.step.lease_token},'not_sent',null,'concurrency_test')`;
  const [next] =
    await sql`select public.claim_housecall_export_step(${intents[1]},'concurrent-worker-b',120) as result`;
  assert.ok(next.result?.step, "released destination could not be reclaimed");
  await sql`select public.finish_housecall_export_step(${next.result.step.id},${next.result.step.lease_token},'not_sent',null,'concurrency_test')`;
  const [approvals] =
    await sql`select count(*)::int as count from public.housecall_write_approvals where intent_id=any(${intents}::uuid[])`;
  assert.equal(approvals.count, 0, "concurrency test unexpectedly granted writes");
  console.log("RA6 concurrent destination leases passed (no provider calls).");
} finally {
  releaseFirst();
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('svl.allow_purge','true',true)`;
      await tx`delete from public.receipts where id=any(${[firstReceipt, secondReceipt]}::uuid[])`;
      await tx`delete from public.manager_job_catalog where id=${job}`;
      await tx`delete from public.receipt_categories where id=${marker}`;
      await tx`delete from auth.users where id=any(${[owner, manager]}::uuid[])`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
