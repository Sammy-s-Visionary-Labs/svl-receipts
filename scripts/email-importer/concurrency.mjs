// Local-only integration check: concurrent approval of two previously unseen
// copies of one transaction must permit only one. No HTTP or Housecall calls.

import assert from "node:assert/strict";
import postgres from "postgres";

const url = process.env.SVL_APPLIED_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error("An isolated local database is required.");
const db = postgres(url, { max: 3, prepare: false });
const actor = "93000000-0000-4000-8000-000000000001";
const receipts = ["93100000-0000-4000-8000-000000000001", "93100000-0000-4000-8000-000000000002"];
try {
  await db`insert into auth.users(id,aud,role,email,raw_app_meta_data) values(${actor},'authenticated','authenticated','concurrent-email-test@example.invalid','{"svl_access_approved":true}')`;
  await db`update public.profiles set role='admin' where id=${actor}`;
  await db`insert into public.receipt_categories(id,label) values('email_concurrency_test','Test materials')`;
  for (const id of receipts)
    await db`insert into public.receipts(id,owner_user_id,status,submitted_at) values(${id},${actor},'needs_review',now())`;
  const snapshot = {
    vendor: "TEST CONCURRENT EMAIL",
    invoiceNumber: "TEST-CONCURRENT-1",
    purchaseDate: "2026-09-16",
    category: "email_concurrency_test",
    referenceTotal: "80.00",
    lines: [],
  };
  const results = await Promise.allSettled(
    receipts.map(
      (id) =>
        db`insert into public.reviews(receipt_id,actor_id,decision,snapshot) values(${id},${actor},'approve',${db.json(snapshot)})`,
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.message, "duplicate_review_required");
  console.log(
    "Concurrent duplicate approvals: one accepted, one blocked. No Housecall work dispatched.",
  );
} finally {
  await db.end();
}
