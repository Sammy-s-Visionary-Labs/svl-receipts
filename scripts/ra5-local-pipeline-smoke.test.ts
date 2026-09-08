/** Explicit, bounded local smoke: never run by the default unit-test command. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RECEIPT_BUCKET } from "@svl/domain";
import { createGeminiReadabilityAdapter, GEMINI_READABILITY_MODEL } from "@svl/integrations";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readReceiptObject } from "@/lib/storage/receipts";
import { runExtraction } from "@/lib/work/extraction";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = randomUUID();
const userId = randomUUID();
const prefix = `ra5-smoke-${runId.slice(0, 8)}`;
const createdReceipts: string[] = [];
const objectKeys: string[] = [];
const jobIds: string[] = [];
const categoryIds: string[] = [];
const reports: Record<string, unknown>[] = [];
let sql: ReturnType<typeof postgres>;
let supabase: SupabaseClient;
let configured = false;
let cleanupVerified = false;
let fixtureManifest: {
  fixtures: Array<{
    id: string;
    images: string[];
    expected: { material_total_cents: number | null; lines: unknown[]; warningCodes?: string[] };
  }>;
};

async function rpc(name: string, args: Record<string, unknown>) {
  const result = await supabase.rpc(name, args);
  if (result.error) throw new Error(`local_rpc_failed:${name}:${result.error.code}`);
  return result.data;
}

beforeAll(async () => {
  if (process.env.SVL_RUN_RA5_LOCAL_PIPELINE !== "true")
    throw new Error("explicit_local_pipeline_flag_required");
  const sourcePath = process.env.SVL_RA5_GEMINI_ENV_FILE;
  if (!sourcePath?.startsWith("/")) throw new Error("absolute_gemini_env_path_required");
  const source = parseEnv(await readFile(sourcePath, "utf8"));
  if (!source.GEMINI_API_KEY) throw new Error("gemini_key_missing");
  const local = JSON.parse(
    execFileSync(`${root}node_modules/.bin/supabase`, ["status", "-o", "json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const api = new URL(local.API_URL);
  const db = new URL(local.DB_URL);
  if (
    !["127.0.0.1", "localhost"].includes(api.hostname) ||
    !["127.0.0.1", "localhost"].includes(db.hostname)
  )
    throw new Error("local_target_required");
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: source.GEMINI_API_KEY,
    GEMINI_EXTRACTION_MODEL:
      source.GEMINI_EXTRACTION_MODEL || source.GEMINI_MODEL || GEMINI_READABILITY_MODEL,
  });
  supabase = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  sql = postgres(local.DB_URL, { max: 1, prepare: false });
  fixtureManifest = JSON.parse(await readFile(`${root}fixtures/ra5/manifest.json`, "utf8"));
  const catalog = JSON.parse(await readFile(`${root}fixtures/ra5/catalog.json`, "utf8"));
  await sql`insert into auth.users(id,aud,role,email) values(${userId},'authenticated','authenticated',${`${prefix}@example.invalid`})`;
  configured = true;
  for (const [index, job] of catalog.jobs.entries()) {
    const id = `${prefix}-job-${index}`;
    jobIds.push(id);
    await sql`insert into public.manager_job_catalog(id,label,customer,job_number,status,scheduled_at,active,po_references,service_address,lat,lng,assigned_worker_ids,vendor_history)
      values(${id},${job.label},${job.customer},${job.number},${job.status},${job.scheduledAt},true,${sql.json(job.poReferences)},${job.serviceAddress},${job.lat},${job.lng},${sql.json([userId])},'[]')`;
  }
  for (const category of catalog.categories) {
    const id = `${prefix}-${category.id}`;
    categoryIds.push(id);
    await sql`insert into public.receipt_categories(id,label,active,keywords,version,approved_by) values(${id},${category.label},true,${sql.json(category.keywords)},1,${userId})`;
  }
});

for (const fixtureId of ["select-multijob", "lowes-ambiguous-missing"]) {
  it(`processes ${fixtureId} through private local storage, actual Gemini and the extraction worker`, async () => {
    const fixture = fixtureManifest.fixtures.find((entry) => entry.id === fixtureId);
    if (!fixture) throw new Error("fixture_missing");
    const receiptId = randomUUID();
    createdReceipts.push(receiptId);
    await sql`insert into public.receipts(id,owner_user_id,status,submitted_at) values(${receiptId},${userId},'processing',now())`;
    for (const [pageIndex, filename] of fixture.images.entries()) {
      const bytes = await readFile(`${root}fixtures/ra5/images/${filename}`);
      const key = `${userId}/${receiptId}/page-${pageIndex}.png`;
      objectKeys.push(key);
      const { error } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .upload(key, bytes, { contentType: "image/png", upsert: false });
      if (error) throw new Error("local_storage_upload_failed");
      await sql`insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at) values(${receiptId},${pageIndex},${key},'image/png',${createHash("sha256").update(bytes).digest("hex")},${bytes.byteLength},now())`;
    }
    const readabilityWorkId = randomUUID();
    await sql`insert into public.work_items(id,receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count) values(${readabilityWorkId},${receiptId},'readability','leased',${prefix},now()+interval '5 minutes',1)`;
    const pages =
      await sql`select page_index,storage_key from public.receipt_pages where receipt_id=${receiptId} order by page_index`;
    const providerPages = [];
    for (const page of pages) {
      const object = await readReceiptObject(page.storage_key);
      if (!object) throw new Error("local_storage_read_failed");
      providerPages.push({
        pageIndex: page.page_index,
        mimeType: "image/png" as const,
        bytes: object.bytes,
      });
    }
    const readability = await createGeminiReadabilityAdapter({
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: process.env.GEMINI_EXTRACTION_MODEL,
      timeoutMs: 45000,
    }).checkReadable(providerPages);
    expect(readability.check.readable).toBe(true);
    await rpc("record_readability_result", {
      p_work_id: readabilityWorkId,
      p_worker_id: prefix,
      p_result: readability.check,
      p_provider: readability.provider,
      p_model: readability.model,
      p_usage: readability.usage,
    });
    await rpc("complete_work", { p_work_id: readabilityWorkId, p_worker_id: prefix });
    const [work] =
      await sql`update public.work_items set status='leased',lease_owner=${prefix},lease_expires_at=now()+interval '5 minutes',attempt_count=1 where receipt_id=${receiptId} and kind='extract' returning id,receipt_id,kind,generation`;
    await rpc("start_queued_work", { p_work_id: work.id, p_worker_id: prefix });
    await runExtraction(
      supabase,
      work as { id: string; receipt_id: string; kind: string; generation: number },
      prefix,
    );
    await rpc("complete_work", { p_work_id: work.id, p_worker_id: prefix });
    const [receipt] = await sql`select status from public.receipts where id=${receiptId}`;
    const [extraction] =
      await sql`select id,model,prompt_version,normalized,lines,raw_text,warnings from public.extractions where receipt_id=${receiptId}`;
    const [privateEvidence] =
      await sql`select length(raw_text)>0 as has_text,jsonb_array_length(field_evidence)>0 as has_fields from receipt_private.extraction_evidence where receipt_id=${receiptId}`;
    const materialLines =
      await sql`select qty,unit_cost_cents,round(qty*unit_cost_cents)::integer as extended from public.receipt_lines where receipt_id=${receiptId} order by sort_index`;
    const suggestions =
      await sql`select housecall_job_id,source_index,reasons from public.job_candidates where receipt_id=${receiptId} and extraction_id=${extraction.id}`;
    expect(receipt.status).toBe("needs_review");
    expect(extraction.lines).toHaveLength(fixture.expected.lines.length);
    expect(extraction.raw_text).toBeNull();
    expect(extraction.normalized.raw_text).toBeUndefined();
    expect(extraction.normalized.original_observation).toBeUndefined();
    expect(extraction.normalized.material_total_cents).toBe(fixture.expected.material_total_cents);
    expect(privateEvidence.has_text).toBe(true);
    expect(privateEvidence.has_fields).toBe(true);
    if (fixtureId === "select-multijob") {
      expect(materialLines.map((line) => line.extended)).toEqual([10000, 7500]);
      expect(
        suggestions.some(
          (candidate) => candidate.housecall_job_id === jobIds[0] && candidate.source_index === 0,
        ),
      ).toBe(true);
      expect(
        suggestions.some(
          (candidate) => candidate.housecall_job_id === jobIds[1] && candidate.source_index === 1,
        ),
      ).toBe(true);
    } else {
      expect(materialLines).toHaveLength(1);
      expect(materialLines[0].extended).toBe(1700);
      expect(extraction.normalized.purchase_date).toBeNull();
      for (const code of fixture.expected.warningCodes ?? [])
        expect(extraction.warnings.some((warning: { code: string }) => warning.code === code)).toBe(
          true,
        );
    }
    expect(
      await sql`select id from public.housecall_intents where receipt_id=${receiptId}`,
    ).toHaveLength(0);
    expect(
      await sql`select id from public.work_items where receipt_id=${receiptId} and kind='export'`,
    ).toHaveLength(0);
    reports.push({
      fixtureId,
      passed: true,
      model: extraction.model,
      promptVersion: extraction.prompt_version,
      status: receipt.status,
      pageCount: pages.length,
      extractedLines: extraction.lines.length,
      projectedMaterialLines: materialLines.length,
      warningCodes: extraction.warnings.map((warning: { code: string }) => warning.code),
      jobCandidateCount: suggestions.length,
      restrictedEvidencePresent: true,
      exportIntentCount: 0,
    });
  });
}

afterAll(async () => {
  let cleanupFailure: unknown;
  try {
    if (objectKeys.length) {
      const { error } = await supabase.storage.from(RECEIPT_BUCKET).remove(objectKeys);
      if (error) throw new Error("local_smoke_storage_cleanup_failed");
    }
    for (const receiptId of createdReceipts) {
      await sql`update public.receipts set status='rejected' where id=${receiptId} and status in ('processing','needs_review','failed')`;
      await sql`update public.receipts set delete_after_at=now()-interval '1 second',purge_claimed_at=now(),purge_claimed_by=${prefix} where id=${receiptId}`;
      await sql`insert into public.work_items(receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count) values(${receiptId},'purge','leased',${prefix},now()+interval '5 minutes',1) on conflict(receipt_id,kind) do update set status='leased',lease_owner=${prefix},lease_expires_at=now()+interval '5 minutes'`;
      await rpc("purge_receipt_content", { p_receipt_id: receiptId, p_worker_id: prefix });
      expect(
        await sql`select extraction_id from receipt_private.extraction_evidence where receipt_id=${receiptId}`,
      ).toHaveLength(0);
    }
  } catch (error) {
    cleanupFailure = error;
  } finally {
    if (sql && configured) {
      await sql.begin(async (tx) => {
        await tx`select set_config('svl.allow_purge','true',true)`;
        for (const id of createdReceipts)
          await tx`delete from public.receipts where id=${id} and owner_user_id=${userId}`;
        for (const id of jobIds) await tx`delete from public.manager_job_catalog where id=${id}`;
        for (const id of categoryIds)
          await tx`delete from public.receipt_categories where id=${id}`;
        await tx`delete from auth.users where id=${userId}`;
      });
      cleanupVerified =
        (await sql`select id from public.receipts where owner_user_id=${userId}`).length === 0;
    }
    if (sql) await sql.end({ timeout: 5 });
    await writeFile(
      `${root}docs/ra5-local-pipeline-results.json`,
      `${JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), target: "local-supabase-only", fixtureOnly: true, fixtureCount: reports.length, reports, cleanupVerified: cleanupVerified && !cleanupFailure, housecallRequests: 0, hostedDatabaseChanges: 0 }, null, 2)}\n`,
    );
  }
  if (cleanupFailure) throw cleanupFailure;
});
