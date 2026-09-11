import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { normalizeReceiptObservation, parseReceiptObservationV1 } from "@svl/domain";
import postgres from "postgres";
import { expect, test } from "vitest";
import { buildReceiptIntelligence } from "../apps/web/lib/manager/intelligence";

/** Retains synthetic review records in the dedicated local runtime. No hosted
 * database, Gemini or Housecall requests; never grants export authorization. */
test.skipIf(process.env.RA6_LOCAL_REVIEW !== "1")(
  "prepare real extraction results for local manager review",
  async () => {
    const local = resolve(".local/ra6");
    const status = JSON.parse(await readFile(resolve(local, "runtime-status.json"), "utf8"));
    expect(status.API_URL).toBe("http://127.0.0.1:55321");
    const databaseUrl = new URL(status.DB_URL);
    expect(databaseUrl.hostname).toBe("127.0.0.1");
    expect(databaseUrl.port).toBe("55322");
    expect(databaseUrl.pathname).toBe("/postgres");
    const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          if (new URL(String(input)).origin !== status.API_URL)
            throw new Error("nonlocal_request_blocked");
          return fetch(input, { ...init, redirect: "error" });
        },
      },
    });
    const sql = postgres(status.DB_URL, { max: 1 });
    const report = JSON.parse(
      await readFile("fixtures/ra6/evaluation/gemini-results.json", "utf8"),
    );
    const baseline = JSON.parse(
      await readFile(resolve(local, "housecall-readonly-results.json"), "utf8"),
    );
    expect(baseline.passed).toBe(true);
    const stateFile = resolve(local, "local-review-state.json");
    type State = {
      email: string;
      password: string;
      adminId: string | null;
      receipts: Record<string, string>;
      completed: boolean;
    };
    const state: State = await readFile(stateFile, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => ({
        email: "ra6-admin@example.invalid",
        password: randomBytes(24).toString("base64url"),
        adminId: null,
        receipts: Object.fromEntries(
          report.results.map((row: { fixture: string }) => [row.fixture, randomUUID()]),
        ),
        completed: false,
      }));
    const saveState = () =>
      writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await saveState();
    try {
      if (!state.adminId) {
        const created = await db.auth.admin.createUser({
          email: state.email,
          password: state.password,
          email_confirm: true,
        });
        if (created.error || !created.data.user) throw new Error("local_admin_creation_failed");
        state.adminId = created.data.user.id;
        await saveState();
      }
      await sql`update public.profiles set role='admin' where id=${state.adminId}`;
      await sql`insert into public.receipt_categories(id,label,keywords) values('ra6-materials','RA6 test materials','["limestone","stone","mulch","fabric"]') on conflict(id) do nothing`;
      for (const job of baseline.jobs.filter(
        (row: { customerNotificationsEnabled: boolean }) =>
          row.customerNotificationsEnabled === false,
      )) {
        await sql`insert into public.manager_job_catalog(id,label,customer,customer_id,job_number,status,active,source,synced_at,unavailable)
        values(${job.id},${`${job.customerName} · Job #${job.invoiceNumber}`},${job.customerName},${job.customerId},${job.invoiceNumber},${job.workStatus},true,'housecall',${baseline.completedAt},false)
        on conflict(id) do nothing`;
      }
      const bucket = await db.storage.getBucket("receipts");
      if (bucket.error) {
        const created = await db.storage.createBucket("receipts", {
          public: false,
          fileSizeLimit: 10 * 1024 * 1024,
        });
        if (created.error) throw new Error("local_bucket_creation_failed");
      }
      for (const row of report.results) {
        if (!row.normalizedPrediction) throw new Error(`missing_prediction:${row.fixture}`);
        const receiptId = state.receipts[row.fixture];
        const existing = await sql`select id from public.extractions where receipt_id=${receiptId}`;
        if (existing.length) continue;
        const response = JSON.parse(
          await readFile(resolve(local, "model-diagnostics", `${row.fixture}.json`), "utf8"),
        );
        const text = response.candidates[0].content.parts
          .filter((part: { thought?: boolean; text?: string }) => !part.thought && part.text)
          .map((part: { text: string }) => part.text)
          .join("");
        const observation = parseReceiptObservationV1(JSON.parse(text), row.images.length);
        if (!observation) throw new Error(`invalid_saved_observation:${row.fixture}`);
        const parsed = normalizeReceiptObservation(observation);
        const {
          raw_text: _raw,
          evidence: _evidence,
          original_observation: _observation,
          ...projection
        } = parsed;
        expect(projection).toEqual(row.normalizedPrediction);
        const pages: Array<{
          storageKey: string;
          pageIndex: number;
          checksum: string;
          size: number;
        }> = [];
        for (const image of row.images) {
          const bytes = await readFile(resolve("fixtures/ra6", image.path));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.sha256);
          const storageKey = `${state.adminId}/${receiptId}/page-${image.pageIndex}.png`;
          const uploaded = await db.storage
            .from("receipts")
            .upload(storageKey, bytes, { contentType: "image/png", upsert: false });
          if (uploaded.error && uploaded.error.message !== "The resource already exists")
            throw new Error("local_image_upload_failed");
          pages.push({
            storageKey,
            pageIndex: image.pageIndex,
            checksum: image.sha256,
            size: bytes.length,
          });
        }
        const workId = randomUUID();
        await sql.begin(async (tx) => {
          await tx`insert into public.receipts(id,owner_user_id,status,submitted_at) values(${receiptId},${state.adminId},'processing',now()) on conflict(id) do nothing`;
          for (const page of pages)
            await tx`insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
          values(${receiptId},${page.pageIndex},${page.storageKey},'image/png',${page.checksum},${page.size},now()) on conflict(receipt_id,page_index) do nothing`;
          const [readability] =
            await tx`insert into public.work_items(receipt_id,kind,status,attempt_count) values(${receiptId},'readability','succeeded',1) on conflict(receipt_id,kind) do update set status='succeeded' returning id`;
          await tx`insert into public.readability_checks(work_item_id,receipt_id,schema_version,provider,model,readable) values(${readability.id},${receiptId},1,'local_fixture','manual_visual_precondition',true) on conflict do nothing`;
          await tx`insert into public.work_items(id,receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count) values(${workId},${receiptId},'extract','leased','ra6-retained-evaluation',now()+interval '5 minutes',1)
          on conflict(receipt_id,kind) do update set lease_owner='ra6-retained-evaluation',lease_expires_at=now()+interval '5 minutes'`;
        });
        const [work] =
          await sql`select id from public.work_items where receipt_id=${receiptId} and kind='extract'`;
        const exact = await db.rpc("record_exact_duplicate_candidates", {
          p_work_id: work.id,
          p_worker_id: "ra6-retained-evaluation",
          p_generation: 1,
        });
        if (exact.error) throw new Error("local_duplicate_recording_failed");
        const intelligence = await buildReceiptIntelligence(db, receiptId, parsed);
        const recorded = await db.rpc("record_extraction_result", {
          p_work_id: work.id,
          p_worker_id: "ra6-retained-evaluation",
          p_generation: 1,
          p_result: parsed,
          p_model: row.actualModel,
          p_prompt_version: row.promptVersion,
          p_usage: row.usage,
          p_intelligence: intelligence,
        });
        if (recorded.error)
          throw new Error(`local_extraction_recording_failed:${recorded.error.code}`);
        const completed = await db.rpc("complete_work", {
          p_work_id: work.id,
          p_worker_id: "ra6-retained-evaluation",
        });
        if (completed.error)
          throw new Error(`local_work_completion_failed:${completed.error.code}`);
      }
      // The upload flow also keeps the first page on the legacy receipt fields
      // used by the current manager image route.
      await sql`update public.receipts r set storage_key=p.storage_key,content_type=p.content_type,checksum=p.checksum,byte_size=p.byte_size
      from public.receipt_pages p where p.receipt_id=r.id and p.page_index=0 and r.storage_key is null`;
      const [counts] =
        await sql`select (select count(*)::int from public.receipts) receipts,(select count(*)::int from public.extractions) extractions,(select count(*)::int from public.housecall_write_approvals) approvals,(select count(*)::int from public.housecall_intents) intents`;
      expect(counts.receipts).toBe(8);
      expect(counts.extractions).toBe(8);
      expect(counts.approvals).toBe(0);
      expect(counts.intents).toBe(0);
      state.completed = true;
      await saveState();
    } finally {
      await sql.end();
    }
  },
);
