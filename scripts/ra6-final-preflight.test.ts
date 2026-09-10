import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createHousecallClient, HOUSECALL_ORIGIN } from "@svl/integrations";
import postgres from "postgres";
import { test } from "vitest";
import { syncHousecallJobs } from "../apps/web/lib/housecall/jobs";
import { closeExportForManualHandling } from "../apps/web/lib/housecall/resolution";

test.skipIf(process.env.RA6_FINAL_PREFLIGHT !== "1")(
  "verify scoped sync and manually close retained precision mismatch using GET only",
  async () => {
    const readJson = async (name: string) =>
      JSON.parse(await readFile(`.local/ra6/${name}.json`, "utf8"));
    const authorization = await readJson("test-customer-authorization");
    assert.equal(
      authorization.userMessage,
      "i am approving you for all the hcp actions as long as they are contained within and only change or read the test customers",
    );
    const bindings = authorization.bindings as Array<{ jobId: string; customerId: string }>;
    assert.equal(bindings.length, 4);
    const customers = new Set(bindings.map((b) => b.customerId));
    const jobs = new Map(bindings.map((b) => [b.jobId, b.customerId]));
    const runtime = await readJson("runtime-status");
    assert.equal(runtime.API_URL, "http://127.0.0.1:55321");
    assert.equal(new URL(runtime.DB_URL).port, "55322");
    const state = await readJson("local-review-state");
    const env = parseEnv(await readFile("apps/web/.env.local", "utf8"));
    assert.equal(env.HOUSECALL_EXPORT_MODE, "disabled");
    const journal = ".local/ra6/final-preflight-journal.jsonl";
    writeFileSync(
      journal,
      `${JSON.stringify({ event: "start", authorization: authorization.recordedAt, providerWritesAllowed: 0 })}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    let reads = 0;
    const record = (value: unknown) =>
      appendFileSync(journal, `${JSON.stringify(value)}\n`, { flush: true });
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, HOUSECALL_ORIGIN);
      assert.equal(init?.method ?? "GET", "GET");
      assert(init?.body == null);
      assert.equal(init?.redirect, "error");
      assert(++reads <= 40);
      if (url.pathname === "/jobs") {
        assert(customers.has(url.searchParams.get("customer_id") || ""));
        assert(
          [...url.searchParams.keys()].every((k) =>
            ["customer_id", "page", "page_size", "sort_by", "sort_direction"].includes(k),
          ),
        );
      } else {
        const match = url.pathname.match(/^\/jobs\/([^/]+)(\/job_input_materials)?$/);
        assert(match && jobs.has(match[1]));
        assert(!url.search || url.search === "?expand%5B%5D=attachments");
      }
      const response = await fetch(input, init);
      record({
        at: new Date().toISOString(),
        method: "GET",
        path: url.pathname + url.search,
        status: response.status,
      });
      if (response.ok && !url.pathname.endsWith("/job_input_materials")) {
        const data = await response.clone().json();
        for (const job of url.pathname === "/jobs" ? data.jobs : [data])
          assert.equal(jobs.get(job.id), job.customer?.id);
      }
      return response;
    };
    const client = createHousecallClient({
      apiKey: env.HOUSECALL_API_KEY || "",
      fetch: transport,
      allowedReadCustomerIds: [...customers],
      allowedReadJobIds: [...jobs.keys()],
      allowedWriteJobIds: [],
    });
    const db = createClient(runtime.API_URL, runtime.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const sql = postgres(runtime.DB_URL, { max: 1 });
    const prior = {
      HOUSECALL_READS_ENABLED: process.env.HOUSECALL_READS_ENABLED,
      HOUSECALL_TEST_JOB_IDS: process.env.HOUSECALL_TEST_JOB_IDS,
      HOUSECALL_TEST_CUSTOMER_IDS: process.env.HOUSECALL_TEST_CUSTOMER_IDS,
    };
    try {
      process.env.HOUSECALL_READS_ENABLED = "true";
      process.env.HOUSECALL_TEST_JOB_IDS = [...jobs.keys()].join(",");
      process.env.HOUSECALL_TEST_CUSTOMER_IDS = [...customers].join(",");
      const health = await client.checkHealth();
      const sync = await syncHousecallJobs({ full: true, db, client });
      assert.equal(sync.scanned, 4);
      const catalog =
        await sql`select id,customer_id,assigned_employee_ids,assigned_worker_ids,synced_at from public.manager_job_catalog where id in ${sql([...jobs.keys()])}`;
      assert.equal(catalog.length, 4);
      for (const row of catalog) assert.equal(jobs.get(row.id), row.customer_id);
      const receiptId = state.receipts["half-up-two-pages"];
      const [intent] =
        await sql`select i.* from public.housecall_intents i join public.housecall_outbox o on o.intent_id=i.id where o.receipt_id=${receiptId} and o.status<>'cancelled'`;
      assert(intent);
      const closed = await closeExportForManualHandling(
        {
          actorId: state.adminId,
          receiptId,
          intentId: intent.id,
          payloadHash: intent.payload_hash,
          reason:
            "RA-6 test-only manual handoff: HCP stored 1.01 for frozen quantity 1.005. User chose to keep quantities beyond two decimals blocked for manager review. Preserve original intent and observed provider rows as evidence; do not resend the mismatched material or the untouched 10.125 line. No real business costs require manual posting for this synthetic test.",
        },
        { db, client },
      );
      assert.deepEqual(
        { closed: closed.closed, exported: closed.exported },
        { closed: true, exported: false },
      );
      const [receipt] =
        await sql`select status,retention_started_at from public.receipts where id=${receiptId}`;
      assert.equal(receipt.status, "partial_success");
      assert.equal(receipt.retention_started_at, null);
      const steps =
        await sql`select id,step,status,dispatch_count,last_error,payload->'line'->'qty' as qty from public.housecall_export_steps where intent_id=${intent.id}`;
      assert.deepEqual(
        steps
          .filter((s) => s.step === "job_cost")
          .map((s) => Number(s.qty))
          .sort((a, b) => a - b),
        [1.005, 10.125],
      );
      const [locks] =
        await sql`select count(*)::int as n from public.housecall_export_locks where step_id in(select id from public.housecall_export_steps where intent_id=${intent.id})`;
      assert.equal(locks.n, 0);
      await writeFile(
        ".local/ra6/final-preflight-results.json",
        `${JSON.stringify({ completedAt: new Date().toISOString(), health, sync, catalog, closed, receipt, steps, reads, providerWrites: 0 }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      record({ event: "stopped", reads, providerWrites: 0 });
      await sql.end();
    }
  },
);
