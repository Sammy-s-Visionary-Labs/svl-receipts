// Explicit synthetic development-only smoke. Never approve or dispatch receipts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.SVL_EMAIL_SMOKE_ENV_FILE) throw new Error("SVL_EMAIL_SMOKE_ENV_FILE is required");
process.loadEnvFile(process.env.SVL_EMAIL_SMOKE_ENV_FILE);
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("vrtcbrowjnipbldoioyr"))
  throw new Error("Development backend required");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const secret = readFileSync("/tmp/svl-email-test-secret", "utf8");
const base = "http://127.0.0.1:3193";
async function post(route, body = {}) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(value)}`);
  return value;
}
const reference = `TEST-EMAIL-SMOKE-${Date.now()}`;
let raw = Buffer.from(
  `From: Test Supplier <test@example.invalid>\r\nTo: recisvl@gmail.com\r\nSubject: SYNTHETIC TEST RECEIPT - DO NOT EXPORT\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSYNTHETIC TEST RECEIPT - DO NOT EXPORT\nTEST EMAIL SUPPLY\nDate: 09/16/2026\nInvoice: ${reference}\nJob: Test Customer 1\nGravel: 2 ton x USD 40.00 = USD 80.00\nSubtotal: USD 80.00\nTax: USD 0.00\nTotal paid: USD 80.00\nPayment: TEST ONLY\n`,
);
if (process.env.SVL_EMAIL_SMOKE_FORMAT === "pdf") {
  const lines = [
    "SYNTHETIC TEST RECEIPT - DO NOT EXPORT",
    "TEST EMAIL SUPPLY",
    "Date: 09/16/2026",
    `Invoice: ${reference}`,
    "Gravel: 2 ton x USD 40.00 = USD 80.00",
    "Subtotal: USD 80.00",
    "Tax: USD 0.00",
    "Total paid: USD 80.00",
  ];
  const stream = `BT /F1 14 Tf 20 550 Td ${lines.map((line, i) => `${i ? "0 -28 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  raw = Buffer.from(
    `From: Test Supplier <test@example.invalid>\r\nTo: recisvl@gmail.com\r\nSubject: SYNTHETIC PDF RECEIPT - DO NOT EXPORT\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="receipt"\r\n\r\n--receipt\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="TEST-RECEIPT.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(pdf).toString("base64")}\r\n--receipt--`,
  );
}
const manifest = {
  messageId: reference,
  checksum: createHash("sha256").update(raw).digest("hex"),
  byteSize: raw.length,
};
const item = await post("/api/email-imports", manifest);
const upload = await fetch(item.uploadUrl, {
  method: "PUT",
  headers: { "content-type": "message/rfc822" },
  body: raw,
});
if (!upload.ok) throw new Error(`Upload ${upload.status}: ${await upload.text()}`);
await post(`/api/email-imports/${item.id}/confirm`);
console.log("Synthetic email original uploaded and accepted.");
const replay = await post("/api/email-imports", manifest);
if (replay.id !== item.id) throw new Error("Replay created a second import");
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const { data: state, error } = await db
    .from("email_receipt_imports")
    .select("status,last_error,email_receipt_documents(receipt_id,receipts(status))")
    .eq("id", item.id)
    .single();
  if (error) throw error;
  if (state.status === "needs_attention") throw new Error(`Preparation ${state.last_error}`);
  const docs = state.email_receipt_documents;
  if (
    docs?.length &&
    docs.every((d) => ["needs_review", "failed", "rejected_unreadable"].includes(d.receipts.status))
  ) {
    const ids = docs.map((d) => d.receipt_id);
    const extraction = await db
      .from("extractions")
      .select("receipt_id,provider,vendor,purchase_date,receipt_total_cents")
      .in("receipt_id", ids);
    const outbox = await db.from("housecall_outbox").select("receipt_id").in("receipt_id", ids);
    if (outbox.error || outbox.data.length) throw new Error("Unexpected Housecall work");
    const report = {
      importId: item.id,
      replaySameId: true,
      documents: docs,
      extraction: extraction.data,
      housecallOutboxCount: outbox.data.length,
    };
    writeFileSync("/tmp/svl-email-dev-smoke.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exit(docs.every((d) => d.receipts.status === "needs_review") ? 0 : 1);
  }
}
throw new Error("Timed out waiting for review queue");
