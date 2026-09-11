import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, test } from "vitest";
import { type ExportStepRow, prepareExportStep } from "../apps/web/lib/housecall/export";

test.skipIf(process.env.RA6_PREPARE_PREVIEW !== "1")(
  "prepare exact requests from the locally reviewed immutable intent without dispatch",
  async () => {
    const directory = resolve(".local/ra6");
    const runtime = JSON.parse(await readFile(resolve(directory, "runtime-status.json"), "utf8"));
    expect(runtime.API_URL).toBe("http://127.0.0.1:55321");
    expect(new URL(runtime.DB_URL).hostname).toBe("127.0.0.1");
    expect(new URL(runtime.DB_URL).port).toBe("55322");
    const state = JSON.parse(await readFile(resolve(directory, "local-review-state.json"), "utf8"));
    const baseline = JSON.parse(
      await readFile(resolve(directory, "housecall-readonly-results.json"), "utf8"),
    );
    const db = createClient(runtime.API_URL, runtime.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          if (
            new URL(String(input)).origin !== runtime.API_URL ||
            (init?.method && init.method !== "GET")
          )
            throw new Error("read_only_local_storage_required");
          return fetch(input, { ...init, redirect: "error" });
        },
      },
    });
    const sql = postgres(runtime.DB_URL, { max: 1 });
    try {
      const inventory = JSON.parse(
        await readFile(resolve(directory, "test-jobs.json"), "utf8"),
      ) as {
        jobs: Array<{ destinationKey: string; housecallJobId: string }>;
      };
      const binding = inventory.jobs.find((job) => job.destinationKey === "test-customer-2");
      if (!binding) throw new Error("Missing private test-job binding");
      const receiptId = state.receipts["select-fractional-base"];
      const [intent] =
        await sql`select i.* from public.housecall_intents i join public.housecall_outbox o on o.intent_id=i.id where o.receipt_id=${receiptId}`;
      expect(intent).toBeDefined();
      const steps =
        await sql`select * from public.housecall_export_steps where intent_id=${intent.id} order by step,id`;
      expect(steps.length).toBe(2);
      const requests = [];
      for (const row of steps) {
        expect(row.housecall_job_id).toBe(binding.housecallJobId);
        expect(row.status).toBe("ready");
        expect(row.dispatch_started_at).toBeNull();
        const prepared = await prepareExportStep(row as unknown as ExportStepRow, async (key) => {
          const { data, error } = await db.storage.from("receipts").download(key);
          if (error || !data) throw new Error("local_receipt_image_unavailable");
          return { bytes: Buffer.from(await data.arrayBuffer()), contentType: data.type };
        });
        const { bytes: _bytes, ...projection } =
          prepared.kind === "attachment" ? prepared : { ...prepared, bytes: undefined };
        requests.push({ ...projection, stepId: row.id, stepPayloadHash: row.payload_hash });
      }
      const material = requests.find((request) => request.kind === "job_cost");
      if (!material || !("body" in material)) throw new Error("material_request_missing");
      expect(material.body.job_input_materials).toEqual([
        expect.objectContaining({
          quantity: 0.5,
          unit_cost: 4200,
          name: "SYNTHETIC TEST #8 limestone bulk",
        }),
      ]);
      const [safety] =
        await sql`select (select count(*)::int from public.housecall_write_approvals) approvals,(select count(*)::int from public.housecall_export_steps where dispatch_started_at is not null) dispatched,(select count(*)::int from public.housecall_links) links`;
      expect(safety).toEqual({ approvals: 0, dispatched: 0, links: 0 });
      const plan = {
        createdAt: new Date().toISOString(),
        liveWritesApproved: false,
        receiptId,
        intentId: intent.id,
        intentPayloadHash: intent.payload_hash,
        approvedReference: intent.approved_reference,
        proposedMaxWrites: 2,
        proposedWindow: "within one hour after explicit user approval",
        retriesAuthorized: false,
        taxExcluded: true,
        materialCostCents: 2100,
        requests,
        baselineObservedAt: baseline.completedAt,
        safety,
      };
      await writeFile(
        resolve(directory, "first-live-write-request.json"),
        `${JSON.stringify(plan, null, 2)}\n`,
        { mode: 0o600 },
      );
      const attachment = requests.find((request) => request.kind === "attachment");
      if (!attachment || !("fileName" in attachment)) throw new Error("attachment_request_missing");
      const text = `# RA-6 first live test — awaiting approval

**Destination:** Test Customer#2, \`${binding.housecallJobId}\` (exact ID from the verified private inventory).

**Receipt:** RA6-SYN-SELECT-001, RA6 Test Stone Supplier, September 1, 2026.
The supplier and US-format date were manually corrected/confirmed in the local manager review. This local receipt approval is not permission to write to Housecall.

![Synthetic receipt](${resolve("fixtures/ra6/images/select-fractional-base.png")})

1. Upload this single PNG receipt page using \`POST ${attachment.path}\`.
2. Add one internal material entry using \`PUT ${material.path}\`: **0.5 ton × $42.00 = $21.00**. The $1.63 reference tax is excluded.

No invoice, payment, status, notification, customer or other job changes. No automatic resend or cleanup. Proposed scope: at most two writes within one hour after approval, followed by GET verification.

The read-only baseline found notifications off and no attachments or materials on this job. Recheck the destination before dispatch; a changed or ambiguous baseline blocks the run.

## Exact material payload

\`\`\`json
${JSON.stringify(material.body, null, 2)}
\`\`\`

## Frozen identifiers

- Receipt: \`${receiptId}\`
- Intent: \`${intent.id}\`
- Intent SHA-256: \`${intent.payload_hash}\`
- Image filename: \`${attachment.fileName}\`
- Image SHA-256: \`${attachment.contentSha256}\`
- Attachment request SHA-256: \`${attachment.requestHash}\`
- Material request SHA-256: \`${material.requestHash}\`

Current database evidence: **0 write approvals, 0 dispatched steps, 0 Housecall result links**.
`;
      await writeFile(resolve(directory, "first-live-write-request.md"), text, { mode: 0o600 });
    } finally {
      await sql.end();
    }
  },
);
