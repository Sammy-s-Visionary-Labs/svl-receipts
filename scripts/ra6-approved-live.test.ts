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

// One-use acceptance runner. The flag alone is insufficient: a separate private
// record of explicit human approval must match the exact reviewed proposal.
// An existing journal blocks reruns, even when the first response was lost.
test.skipIf(process.env.RA6_EXECUTE_APPROVED_FIRST_TEST !== "1")(
  "execute the explicitly approved first test once, with exact transport bounds",
  async () => {
    const directory = resolve(".local/ra6");
    const remainingMaterial = process.env.RA6_REMAINING_APPROVED_MATERIAL === "1";
    const writeBudget = remainingMaterial ? 1 : 2;
    const readJson = async (name: string) =>
      JSON.parse(await readFile(resolve(directory, name), "utf8"));
    const plan = await readJson("first-live-write-request.json");
    const approval = await readJson("first-live-write-approval.json");
    const runtime = await readJson("runtime-status.json");
    const state = await readJson("local-review-state.json");
    const env = parseEnv(await readFile("apps/web/.env.local", "utf8"));
    assert.equal(runtime.API_URL, "http://127.0.0.1:55321");
    assert.equal(new URL(runtime.DB_URL).hostname, "127.0.0.1");
    assert.equal(new URL(runtime.DB_URL).port, "55322");
    assert.equal(env.HOUSECALL_EXPORT_MODE, "disabled");
    assert.equal(env.HOUSECALL_TEST_JOB_IDS || "", "");
    assert.equal(approval.userMessage, "yes you have my approval");
    assert.equal(approval.intentId, plan.intentId);
    assert.equal(approval.intentPayloadHash, plan.intentPayloadHash);
    assert.equal(approval.maxWrites, 2);
    assert.equal(approval.retriesAuthorized, false);
    assert.equal(plan.requests.length, 2);
    assert(Date.parse(approval.approvedAt) <= Date.now());
    assert(Date.parse(approval.expiresAt) > Date.now());
    assert(Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt) <= 3_600_000);
    assert.deepEqual(
      approval.requestHashes,
      plan.requests.map((r: PreparedHousecallWrite) => r.requestHash),
    );
    assert(plan.requests.every((r: PreparedHousecallWrite) => r.jobId === approval.jobId));

    const priorAttempts: string[] = [];
    if (remainingMaterial) {
      const previousJournal = (
        await readFile(resolve(directory, "first-live-write-journal.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const reservations = previousJournal.filter((entry) => entry.event === "write_reserved");
      assert.equal(reservations.length, 1);
      const attachment = plan.requests.find((r: PreparedHousecallWrite) => r.kind === "attachment");
      assert.equal(reservations[0].requestHash, attachment.requestHash);
      assert(previousJournal.some((entry) => entry.event === "approval_closed" && entry.succeeded));
      priorAttempts.push(attachment.requestHash);
    }
    const journal = resolve(
      directory,
      remainingMaterial ? "first-live-material-journal.jsonl" : "first-live-write-journal.jsonl",
    );
    writeFileSync(journal, `${JSON.stringify({ event: "started", ...approval })}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    const record = (entry: Record<string, unknown>) =>
      appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
        flush: true,
      });
    let writes = 0;
    let reads = 0;
    let enabled = false;
    const attempted = new Set<string>(priorAttempts);
    const allowedReadPaths = new Set([
      `/jobs/${approval.jobId}`,
      `/jobs/${approval.jobId}?expand%5B%5D=attachments`,
      `/jobs/${approval.jobId}/job_input_materials`,
    ]);
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, HOUSECALL_ORIGIN);
      assert.equal(init?.redirect, "error");
      const path = `${url.pathname}${url.search}`;
      const method = init?.method || "GET";
      if (method === "GET") {
        assert(allowedReadPaths.has(path) && init?.body == null && ++reads <= 30);
      } else {
        assert(enabled && Date.now() < Date.parse(approval.expiresAt));
        const expected = plan.requests.find(
          (r: PreparedHousecallWrite) => r.method === method && r.path === path,
        );
        assert(expected && !attempted.has(expected.requestHash) && writes < writeBudget);
        if (remainingMaterial) assert.equal(expected.kind, "job_cost");
        if (expected.kind === "attachment") {
          assert(init?.body instanceof FormData);
          assert.deepEqual([...init.body.keys()], ["file"]);
          const file = init.body.get("file");
          assert(file instanceof File);
          assert.equal(file.name, expected.fileName);
          assert.equal(file.type, expected.contentType);
          assert.equal(
            createHash("sha256")
              .update(Buffer.from(await file.arrayBuffer()))
              .digest("hex"),
            expected.contentSha256,
          );
        } else {
          assert.equal(typeof init?.body, "string");
          assert.deepEqual(JSON.parse(init.body as string), expected.body);
        }
        attempted.add(expected.requestHash);
        writes++;
        // Durable reservation precedes network dispatch; failures never release it.
        record({
          event: "write_reserved",
          method,
          path,
          requestHash: expected.requestHash,
          writeNumber: writes,
        });
      }
      const response = await fetch(input, init);
      record({ event: "response", method, path, httpStatus: response.status });
      return response;
    };
    const client = createHousecallClient({
      apiKey: env.HOUSECALL_API_KEY || "",
      fetch: transport,
      allowedWriteJobIds: [approval.jobId],
      timeoutMs: 20_000,
    });
    const db = createClient(runtime.API_URL, runtime.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          assert.equal(new URL(String(input)).origin, runtime.API_URL);
          return fetch(input, { ...init, redirect: "error" });
        },
      },
    });
    const readObject = async (key: string) => {
      const { data, error } = await db.storage.from("receipts").download(key);
      if (error || !data) throw new Error("local_receipt_image_unavailable");
      return { bytes: Buffer.from(await data.arrayBuffer()), contentType: data.type };
    };
    const sql = postgres(runtime.DB_URL, { max: 1 });
    let grantId: string | null = null;
    const previous = {
      reads: process.env.HOUSECALL_READS_ENABLED,
      mode: process.env.HOUSECALL_EXPORT_MODE,
      jobs: process.env.HOUSECALL_TEST_JOB_IDS,
    };
    try {
      const [intent] =
        await sql`select i.* from public.housecall_intents i join public.housecall_outbox o on o.intent_id=i.id where o.receipt_id=${plan.receiptId}`;
      assert.equal(intent.id, plan.intentId);
      assert.equal(intent.payload_hash, plan.intentPayloadHash);
      const steps =
        await sql`select * from public.housecall_export_steps where intent_id=${plan.intentId} order by step,id`;
      assert.equal(steps.length, 2);
      for (const step of steps) {
        const expected = plan.requests.find((r: { stepId: string }) => r.stepId === step.id);
        assert(expected);
        assert.equal(step.payload_hash, expected.stepPayloadHash);
        if (remainingMaterial && step.step === "attachment") {
          assert.equal(step.status, "reconcile_required");
          assert.equal(step.dispatch_count, 1);
        } else {
          assert.equal(step.status, "ready");
          assert.equal(step.dispatch_started_at, null);
          assert.equal(step.dispatch_count, 0);
        }
        const prepared = await prepareExportStep(step as unknown as ExportStepRow, readObject);
        assert.equal(prepared.requestHash, expected.requestHash);
      }
      const [counts] =
        await sql`select (select count(*)::int from public.housecall_write_approvals) approvals,(select count(*)::int from public.housecall_export_steps where dispatch_started_at is not null) dispatched`;
      assert.deepEqual(counts, {
        approvals: remainingMaterial ? 1 : 0,
        dispatched: remainingMaterial ? 1 : 0,
      });
      if (remainingMaterial) {
        const [previousGrant] =
          await sql`select * from public.housecall_write_approvals where intent_id=${plan.intentId}`;
        assert(previousGrant.revoked_at);
        assert.equal(previousGrant.used_writes, 1);
        assert.equal(previousGrant.payload_hash, plan.intentPayloadHash);
      }
      const job = await client.getJob(approval.jobId, { includeAttachments: true });
      const materials = await client.listJobInputMaterials(approval.jobId);
      assert.equal(job.customerId, approval.customerId);
      assert.equal(job.customerName.replace(/\s/g, ""), "TestCustomer#2");
      assert.equal(job.invoiceNumber, "2000");
      assert.equal(job.workStatus, "needs scheduling");
      assert.equal(job.customerNotificationsEnabled, false);
      assert(job.active && !job.canceled && !job.deleted && !job.locked);
      assert.deepEqual(job.assignedEmployeeIds, []);
      if (remainingMaterial) {
        const attachment = plan.requests.find(
          (r: PreparedHousecallWrite) => r.kind === "attachment",
        );
        assert.equal(job.attachments?.length, 1);
        assert.equal(job.attachments[0].fileName, attachment.fileName);
        process.env.HOUSECALL_READS_ENABLED = "true";
        process.env.HOUSECALL_EXPORT_MODE = "disabled";
        process.env.HOUSECALL_TEST_JOB_IDS = approval.jobId;
        const reconciliation = await runReceiptHousecallExport(plan.receiptId, {
          db,
          client,
          readObject,
          reconcileOnly: true,
        });
        record({ event: "read_only_reconciliation", reconciliation });
        assert.equal(reconciliation.completed, 1);
        assert.equal(reconciliation.unresolved, 0);
        assert.equal(writes, 0);
      } else assert.deepEqual(job.attachments, []);
      assert.deepEqual(materials, []);
      record({
        event: "preflight_passed",
        attachmentCount: job.attachments?.length,
        materialCount: 0,
      });
      const { data: grant, error } = await db.rpc("grant_housecall_write_approval", {
        p_actor_id: state.adminId,
        p_intent_id: plan.intentId,
        p_payload_hash: plan.intentPayloadHash,
        p_job_ids: [approval.jobId],
        p_expires_at: approval.expiresAt,
        p_max_writes: writeBudget,
        p_reason: `User explicitly replied "${approval.userMessage}"; recorded ${approval.approvedAt}. Approved exact frozen synthetic receipt POST and $21.00 material PUT for Test Customer#2 job #2000. At most two writes total, no retries or cleanup. This run has ${writeBudget} remaining writes; the original expiry is unchanged. Request hashes: ${approval.requestHashes.join(", ")}`,
      });
      if (error) throw new Error(`local_approval_failed:${error.code}`);
      assert(grant?.id);
      grantId = grant.id;
      record({ event: "approval_granted", grantId });
      process.env.HOUSECALL_READS_ENABLED = "true";
      process.env.HOUSECALL_EXPORT_MODE = "approved_test";
      process.env.HOUSECALL_TEST_JOB_IDS = approval.jobId;
      enabled = true;
      const result = await runReceiptHousecallExport(plan.receiptId, { db, client, readObject });
      enabled = false;
      record({ event: "runner_result", result, writes, reads });
      const after = await client.getJob(approval.jobId, { includeAttachments: true });
      const afterMaterials = await client.listJobInputMaterials(approval.jobId);
      const finalSteps =
        await sql`select id,step,status,external_id,dispatch_started_at,dispatch_count from public.housecall_export_steps where intent_id=${plan.intentId} order by step,id`;
      const [receipt] = await sql`select id,status from public.receipts where id=${plan.receiptId}`;
      await writeFile(
        resolve(
          directory,
          remainingMaterial ? "first-live-material-results.json" : "first-live-write-results.json",
        ),
        `${JSON.stringify({ completedAt: new Date().toISOString(), result, writes, reads, grantId, attachments: after.attachments?.map(({ url: _url, ...row }) => row), materials: afterMaterials, steps: finalSteps, receipt, notificationsEnabled: after.customerNotificationsEnabled, workStatus: after.workStatus }, null, 2)}\n`,
        { mode: 0o600 },
      );
      assert.equal(result.skipped, undefined);
      assert.equal(
        result.unresolved,
        0,
        "Provider outcome requires GET-only reconciliation; do not resend",
      );
      assert.equal(result.completed, writeBudget);
      assert.equal(writes, writeBudget);
      assert.equal(after.attachments?.length, 1);
      assert.equal(afterMaterials.length, 1);
      assert(finalSteps.every((step) => step.status === "succeeded" && step.external_id));
    } finally {
      enabled = false;
      for (const [key, value] of Object.entries({
        HOUSECALL_READS_ENABLED: previous.reads,
        HOUSECALL_EXPORT_MODE: previous.mode,
        HOUSECALL_TEST_JOB_IDS: previous.jobs,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (grantId) {
        const { error } = await db.rpc("revoke_housecall_write_approval", {
          p_actor_id: state.adminId,
          p_approval_id: grantId,
          p_reason:
            "One-use acceptance run closed; additional dispatch requires review of remaining explicit scope.",
        });
        record({ event: "approval_closed", grantId, succeeded: !error });
      }
      record({ event: "stopped", writes, reads });
      await sql.end();
    }
  },
);
