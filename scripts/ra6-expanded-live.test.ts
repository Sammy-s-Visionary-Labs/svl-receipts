import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
  createHousecallClient,
  HOUSECALL_ORIGIN,
  type PreparedHousecallWrite,
} from "@svl/integrations";
import postgres from "postgres";
import { test } from "vitest";
import {
  type ExportStepRow,
  prepareExportStep,
  runReceiptHousecallExport,
} from "../apps/web/lib/housecall/export";

// Fixed acceptance bundle under standing test-customer authorization. This does
// not enable normal workers, general customer searches, or account-wide reads.
test.skipIf(process.env.RA6_EXPANDED_LIVE !== "1")(
  "verify multi-job, multipage and append exports within exact test customers",
  async () => {
    const directory = resolve(".local/ra6");
    const handwrittenOnly = process.env.RA6_HANDWRITTEN_ONLY === "1";
    const writeBudget = handwrittenOnly ? 2 : 12;
    const readJson = async (file: string) =>
      JSON.parse(await readFile(resolve(directory, file), "utf8"));
    const authorization = await readJson("test-customer-authorization.json");
    assert.equal(
      authorization.userMessage,
      "i am approving you for all the hcp actions as long as they are contained within and only change or read the test customers",
    );
    assert.equal(authorization.bindings.length, 4);
    const bindings = authorization.bindings as Array<{
      destinationKey: string;
      jobId: string;
      customerId: string;
    }>;
    const approvedBindings = new Map(bindings.map((binding) => [binding.jobId, binding]));
    const runtime = await readJson("runtime-status.json");
    assert.equal(runtime.API_URL, "http://127.0.0.1:55321");
    assert.equal(new URL(runtime.DB_URL).hostname, "127.0.0.1");
    assert.equal(new URL(runtime.DB_URL).port, "55322");
    const state = await readJson("local-review-state.json");
    const env = parseEnv(await readFile("apps/web/.env.local", "utf8"));
    assert.equal(env.HOUSECALL_EXPORT_MODE, "disabled");
    assert.equal(env.HOUSECALL_TEST_JOB_IDS || "", "");
    const db = createClient(runtime.API_URL, runtime.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          assert.equal(new URL(String(input)).origin, runtime.API_URL);
          return fetch(input, { ...init, redirect: "error" });
        },
      },
    });
    const sql = postgres(runtime.DB_URL, { max: 1 });
    const readObject = async (key: string) => {
      const { data, error } = await db.storage.from("receipts").download(key);
      assert(!error && data, "local_image_unavailable");
      return { bytes: Buffer.from(await data.arrayBuffer()), contentType: data.type };
    };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const plans: Array<{
      fixture: string;
      receiptId: string;
      intentId: string;
      payloadHash: string;
      requests: PreparedHousecallWrite[];
    }> = [];
    const results: Array<Record<string, unknown>> = [];
    const grants: string[] = [];
    let writes = 0;
    let reads = 0;
    let enabled = false;
    let journalCreated = false;
    const journal = resolve(
      directory,
      handwrittenOnly ? "handwritten-live-journal.jsonl" : "expanded-live-journal.jsonl",
    );
    const record = (entry: Record<string, unknown>) =>
      appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
        flush: true,
      });
    const previous = {
      reads: process.env.HOUSECALL_READS_ENABLED,
      mode: process.env.HOUSECALL_EXPORT_MODE,
      jobs: process.env.HOUSECALL_TEST_JOB_IDS,
    };
    try {
      for (const fixture of handwrittenOnly
        ? ["sandman-handwritten"]
        : ["klumm-two-jobs", "half-up-two-pages", "sandman-handwritten"]) {
        const receiptId = state.receipts[fixture];
        const preview = await readJson(`${fixture}-preview.json`);
        const [intent] =
          await sql`select i.* from public.housecall_intents i join public.housecall_outbox o on o.intent_id=i.id where o.receipt_id=${receiptId}`;
        assert.equal(intent.id, preview.intentId);
        const steps =
          await sql`select * from public.housecall_export_steps where intent_id=${intent.id} order by step,id`;
        assert.equal(
          steps.length,
          fixture === "klumm-two-jobs" ? 4 : fixture === "half-up-two-pages" ? 6 : 2,
        );
        const requests: PreparedHousecallWrite[] = [];
        for (const step of steps) {
          assert.equal(step.status, "ready");
          assert.equal(step.dispatch_count, 0);
          assert(approvedBindings.has(step.housecall_job_id));
          requests.push(await prepareExportStep(step as unknown as ExportStepRow, readObject));
        }
        plans.push({
          fixture,
          receiptId,
          intentId: intent.id,
          payloadHash: intent.payload_hash,
          requests,
        });
      }
      const requests = plans.flatMap((plan) => plan.requests);
      assert.equal(requests.length, writeBudget);
      const allowedJobIds = [...new Set(requests.map((request) => request.jobId))];
      const allowedReadPaths = new Set(
        allowedJobIds.flatMap((jobId) => [
          `/jobs/${jobId}`,
          `/jobs/${jobId}?expand%5B%5D=attachments`,
          `/jobs/${jobId}/job_input_materials`,
        ]),
      );
      const used = new Set<string>();
      const safePlans = plans.map((plan) => ({
        ...plan,
        requests: plan.requests.map((request) => {
          const { bytes: _bytes, ...safe } =
            request.kind === "attachment" ? request : { ...request, bytes: undefined };
          return safe;
        }),
      }));
      writeFileSync(
        journal,
        `${JSON.stringify({ event: "planned", authorizationRecordedAt: authorization.recordedAt, expiresAt, maxWrites: writeBudget, plans: safePlans })}\n`,
        { flag: "wx", mode: 0o600, flush: true },
      );
      journalCreated = true;
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, HOUSECALL_ORIGIN);
        assert.equal(init?.redirect, "error");
        const path = `${url.pathname}${url.search}`;
        const method = init?.method || "GET";
        if (method === "GET") {
          assert(
            allowedReadPaths.has(path) && init?.body == null && ++reads <= 120,
            "test_customer_read_scope",
          );
        } else {
          assert(enabled && Date.now() < Date.parse(expiresAt) && writes < writeBudget);
          let match: PreparedHousecallWrite | undefined;
          if (method === "POST") {
            assert(init?.body instanceof FormData);
            assert.deepEqual([...init.body.keys()], ["file"]);
            const file = init.body.get("file");
            assert(file instanceof File);
            match = requests.find(
              (request) =>
                request.kind === "attachment" &&
                request.path === path &&
                request.fileName === file.name,
            );
            assert(match?.kind === "attachment");
            assert.equal(file.type, match.contentType);
            assert.equal(
              createHash("sha256")
                .update(Buffer.from(await file.arrayBuffer()))
                .digest("hex"),
              match.contentSha256,
            );
          } else {
            assert.equal(method, "PUT");
            assert.equal(typeof init?.body, "string");
            const body = JSON.parse(init.body as string);
            match = requests.find(
              (request) =>
                request.kind === "job_cost" &&
                request.path === path &&
                JSON.stringify(request.body) === JSON.stringify(body),
            );
            assert(match?.kind === "job_cost");
          }
          assert(approvedBindings.has(match.jobId) && !used.has(match.requestHash));
          used.add(match.requestHash);
          writes++;
          record({
            event: "write_reserved",
            method,
            path,
            requestHash: match.requestHash,
            writeNumber: writes,
          });
        }
        const response = await fetch(input, init);
        record({ event: "response", method, path, httpStatus: response.status });
        if (method === "GET" && response.ok && !url.pathname.endsWith("/job_input_materials")) {
          const body = await response.clone().json();
          const binding = approvedBindings.get(body.id);
          assert(
            binding &&
              body.id === url.pathname.split("/")[2] &&
              body.customer?.id === binding.customerId,
            "test_customer_association_changed",
          );
        }
        return response;
      };
      const client = createHousecallClient({
        apiKey: env.HOUSECALL_API_KEY || "",
        fetch: transport,
        allowedWriteJobIds: allowedJobIds,
        timeoutMs: 20_000,
      });
      process.env.HOUSECALL_READS_ENABLED = "true";
      process.env.HOUSECALL_EXPORT_MODE = "approved_test";
      process.env.HOUSECALL_TEST_JOB_IDS = allowedJobIds.join(",");
      // Complete all baseline reads before the first mutation.
      for (const jobId of allowedJobIds) {
        const job = await client.getJob(jobId, { includeAttachments: true });
        assert(job.active && !job.canceled && !job.deleted && !job.locked);
        assert.equal(job.customerNotificationsEnabled, false);
      }
      for (const plan of plans) {
        const jobIds = [...new Set(plan.requests.map((request) => request.jobId))];
        const before = new Map();
        for (const jobId of jobIds) {
          const job = await client.getJob(jobId, { includeAttachments: true });
          before.set(jobId, {
            attachments: job.attachments?.map(({ url: _url, ...row }) => row),
            materials: await client.listJobInputMaterials(jobId),
          });
        }
        for (const request of plan.requests)
          assert.equal((await client.reconcileWrite(request)).status, "absent");
        record({ event: "baseline", fixture: plan.fixture, jobs: Object.fromEntries(before) });
        const { data: grant, error } = await db.rpc("grant_housecall_write_approval", {
          p_actor_id: state.adminId,
          p_intent_id: plan.intentId,
          p_payload_hash: plan.payloadHash,
          p_job_ids: jobIds,
          p_expires_at: expiresAt,
          p_max_writes: plan.requests.length,
          p_reason: `Standing user approval recorded ${authorization.recordedAt}: all HCP actions confined to verified test customers. Frozen synthetic acceptance case ${plan.fixture}, ${plan.requests.length} exact requests. No repeated request hashes; readback and existing-row preservation required.`,
        });
        assert(!error && grant?.id, "local_grant_failed");
        grants.push(grant.id);
        enabled = true;
        const result = await runReceiptHousecallExport(plan.receiptId, { db, client, readObject });
        enabled = false;
        record({ event: "runner_result", fixture: plan.fixture, result });
        assert.equal(
          result.unresolved,
          0,
          "Stop for GET-only reconciliation; never rerun this journal",
        );
        assert.equal(result.completed, plan.requests.length);
        const afterJobs = [];
        for (const jobId of jobIds) {
          const job = await client.getJob(jobId, { includeAttachments: true });
          const attachments = job.attachments?.map(({ url: _url, ...row }) => row) || [];
          const materials = await client.listJobInputMaterials(jobId);
          const old = before.get(jobId);
          for (const row of old.attachments)
            assert.deepEqual(
              attachments.find((current) => current.id === row.id),
              row,
              "existing_attachment_changed",
            );
          for (const row of old.materials)
            assert.deepEqual(
              materials.find((current) => current.id === row.id),
              row,
              "existing_material_changed",
            );
          assert.equal(
            attachments.length,
            old.attachments.length +
              plan.requests.filter(
                (request) => request.jobId === jobId && request.kind === "attachment",
              ).length,
          );
          assert.equal(
            materials.length,
            old.materials.length +
              plan.requests.filter(
                (request) => request.jobId === jobId && request.kind === "job_cost",
              ).length,
          );
          assert.equal(job.customerNotificationsEnabled, false);
          afterJobs.push({ jobId, attachments, materials, existingRowsPreserved: true });
        }
        const steps =
          await sql`select step,status,external_id,dispatch_count from public.housecall_export_steps where intent_id=${plan.intentId}`;
        const [receipt] = await sql`select status from public.receipts where id=${plan.receiptId}`;
        assert(
          steps.every(
            (step) => step.status === "succeeded" && step.external_id && step.dispatch_count === 1,
          ),
        );
        assert.equal(receipt.status, "exported");
        const writesBeforeReplay = writes;
        const replay = await runReceiptHousecallExport(plan.receiptId, { db, client, readObject });
        assert.equal(writes, writesBeforeReplay);
        assert.deepEqual(replay, { completed: 0, unresolved: 0 });
        const { error: revokeError } = await db.rpc("revoke_housecall_write_approval", {
          p_actor_id: state.adminId,
          p_approval_id: grant.id,
          p_reason:
            "Scoped acceptance completed; per-run grant closed, standing customer authorization retained.",
        });
        assert(!revokeError);
        grants.splice(grants.indexOf(grant.id), 1);
        results.push({
          fixture: plan.fixture,
          result,
          steps,
          receipt,
          afterJobs,
          replayWriteCount: writes - writesBeforeReplay,
        });
        await writeFile(
          resolve(
            directory,
            handwrittenOnly ? "handwritten-live-results.json" : "expanded-live-results.json",
          ),
          `${JSON.stringify({ completedAt: new Date().toISOString(), writes, reads, results }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      assert.equal(writes, writeBudget);
    } finally {
      enabled = false;
      for (const grantId of grants) {
        const { error } = await db.rpc("revoke_housecall_write_approval", {
          p_actor_id: state.adminId,
          p_approval_id: grantId,
          p_reason: "Acceptance runner stopped; close unused dispatch budget.",
        });
        if (journalCreated) record({ event: "grant_closed", grantId, succeeded: !error });
      }
      for (const [key, value] of Object.entries({
        HOUSECALL_READS_ENABLED: previous.reads,
        HOUSECALL_EXPORT_MODE: previous.mode,
        HOUSECALL_TEST_JOB_IDS: previous.jobs,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (journalCreated) record({ event: "stopped", writes, reads });
      await sql.end();
    }
  },
);
