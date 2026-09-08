/** Opt-in, two synthetic receipt smoke. Root must finish scoped SQL retention cleanup. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const DEV_REF = "vrtcbrowjnipbldoioyr";
const FIXTURES = ["select-multijob", "lowes-ambiguous-missing"];
const BUCKET = "receipts";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/verify-ra5-preview-pipeline.mjs --run-synthetic-upload-smoke --preview-url https://DEPLOYMENT.vercel.app --deployment-sha VERIFIED_READY_SHA --env /absolute/dev/.env.local --expected-project-ref vrtcbrowjnipbldoioyr [--report docs/ra5-preview-pipeline-results.json]",
  );
  console.log(
    "Creates only2 marked synthetic worker receipts through init/upload/confirm, waits only on those IDs, checks actual deployed extraction and private evidence, then removes its exact objects only when its work is terminal. Never approves, drains a global queue, seeds jobs/categories, or calls Housecall. Root must finish SQL retention cleanup from the saved receipt-ID manifest.",
  );
  process.exit(0);
}
const optedIn = args.includes("--run-synthetic-upload-smoke");
const remaining = args.filter((value) => value !== "--run-synthetic-upload-smoke");
const options = new Map();
for (let index = 0; index < remaining.length; index += 2) {
  const key = remaining[index];
  const value = remaining[index + 1];
  if (
    !["--preview-url", "--deployment-sha", "--env", "--expected-project-ref", "--report"].includes(
      key,
    ) ||
    !value ||
    value.startsWith("--") ||
    options.has(key)
  ) {
    console.error("invalid_arguments_use_help");
    process.exit(1);
  }
  options.set(key, value);
}
const reportPath = resolve(options.get("--report") ?? "docs/ra5-preview-pipeline-results.json");
if (!reportPath.startsWith(`${resolve("docs")}/`)) {
  console.error("report_must_be_inside_workspace_docs");
  process.exit(1);
}
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const safeCode = (cause) =>
  cause instanceof Error && /^[a-z0-9_:-]{1,140}$/.test(cause.message)
    ? cause.message
    : "preview_pipeline_check_failed";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const versionSafe = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,120}$/.test(value) ? value : null;
const runId = randomUUID();
const marker = `ra5-preview-smoke-${runId}`;
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  targetProjectRef: DEV_REF,
  previewHost: null,
  deploymentCommit: null,
  deploymentCommitSource: "Ready deployment identity supplied by the coordinating agent",
  synthetic: true,
  fixtureLimit: 2,
  status: "not_run",
  runId,
  testOwnerId: null,
  receipts: [],
  cleanup: { storageVerified: false, database: "not_required" },
  housecallRequests: 0,
  globalQueueTriggers: 0,
  approvals: 0,
  jobsOrCategoriesSeeded: 0,
};
let reportInitialized = false;
let service;
let worker;
let admin;
let preview;
let endpoint;
let appRequests = 0;
let fixtureData;
const ownedObjects = new Map();
async function save() {
  if (reportInitialized)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
async function app(path, { token, body } = {}) {
  assert(++appRequests <= 150, "app_request_budget_exceeded");
  assert(
    path === "/api/me" ||
      path === "/api/upload-sessions" ||
      report.receipts.some(
        (entry) =>
          path.startsWith(`/api/receipts/${entry.receiptId}`) ||
          path.startsWith(`/api/manager/receipts/${entry.receiptId}`),
      ),
    "unscoped_app_request_rejected",
  );
  assert(!/approve|recovery|cron|jobs|categories/.test(path), "out_of_scope_app_route_rejected");
  const response = await fetch(new URL(path, preview), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
    redirect: "manual",
  });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  assert(text.length <= 2_000_000, "response_size_exceeded");
  if (!type.includes("application/json")) {
    if (
      response.headers.get("x-vercel-mitigated") ||
      /authentication required|vercel authentication|deployment protection|security checkpoint/i.test(
        text,
      ) ||
      [301, 302, 303, 307, 308].includes(response.status)
    )
      throw new Error("preview_access_protected");
    throw new Error(`non_json_preview_response:http${response.status}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("invalid_preview_json");
  }
  return { status: response.status, data };
}
async function db(query, name) {
  const result = await query;
  if (result.error) throw new Error(`scoped_database_read_failed:${name}`);
  return result.data;
}
async function assertNoExports(receiptId) {
  const results = await Promise.allSettled([
    db(
      service.from("housecall_intents").select("id").eq("receipt_id", receiptId).limit(1),
      "intents",
    ),
    db(
      service.from("housecall_outbox").select("receipt_id").eq("receipt_id", receiptId).limit(1),
      "outbox",
    ),
    db(
      service
        .from("work_items")
        .select("id")
        .eq("receipt_id", receiptId)
        .eq("kind", "export")
        .limit(1),
      "export_work",
    ),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    assert(result.value.length === 0, "unexpected_export_work_for_synthetic_receipt");
  }
}
async function cleanupObjects() {
  let all = true;
  for (const entry of report.receipts) {
    try {
      const receipt = await db(
        service.from("receipts").select("id,owner_user_id").eq("id", entry.receiptId).maybeSingle(),
        "cleanup_receipt",
      );
      if (!receipt) {
        entry.storageCleanupVerified = true;
        entry.databaseCleanup = "not_required";
        continue;
      }
      assert(receipt.owner_user_id === report.testOwnerId, "cleanup_owner_mismatch");
      entry.databaseCleanup = "pending_root_scoped_retention_purge";
      await assertNoExports(entry.receiptId);
      let active = true;
      for (let wait = 0; wait < 15; wait++) {
        const work = await db(
          service
            .from("work_items")
            .select("kind,status")
            .eq("receipt_id", entry.receiptId)
            .limit(20),
          "cleanup_work",
        );
        active = work.some(
          (item) =>
            ["readability", "extract"].includes(item.kind) &&
            ["queued", "leased"].includes(item.status),
        );
        if (!active) break;
        await pause(2000);
      }
      if (active) {
        entry.cleanupReason = "own_work_still_active_preserved_images_for_root_fence";
        entry.storageCleanupVerified = false;
        all = false;
        continue;
      }
      const pages = await db(
        service
          .from("receipt_pages")
          .select("storage_key,original_filename")
          .eq("receipt_id", entry.receiptId)
          .order("page_index"),
        "cleanup_pages",
      );
      const prefix = `${report.testOwnerId}/${entry.receiptId}/`;
      assert(
        pages.length <= 1 &&
          pages.every(
            (page) =>
              page.storage_key.startsWith(prefix) &&
              page.original_filename === `${marker}-${entry.fixture}.png`,
          ),
        "cleanup_page_scope_mismatch",
      );
      const keys = [
        ...new Set([
          ...pages.map((page) => page.storage_key),
          ...(ownedObjects.get(entry.receiptId) ?? []),
        ]),
      ];
      assert(
        keys.length <= 1 && keys.every((key) => key.startsWith(prefix)),
        "cleanup_object_scope_mismatch",
      );
      if (keys.length) {
        const { error } = await service.storage.from(BUCKET).remove(keys);
        if (error) throw new Error("exact_object_cleanup_failed");
      }
      const { data: remainingObjects, error: listError } = await service.storage
        .from(BUCKET)
        .list(prefix.slice(0, -1), { limit: 10 });
      assert(
        !listError && Array.isArray(remainingObjects) && remainingObjects.length === 0,
        "exact_object_cleanup_not_verified",
      );
      entry.storageCleanupVerified = true;
      entry.removedObjectCount = keys.length;
    } catch (cause) {
      all = false;
      entry.storageCleanupVerified = false;
      entry.cleanupReason = safeCode(cause);
    }
    await save();
  }
  report.cleanup.storageVerified = all;
  report.cleanup.database = report.receipts.some(
    (entry) => entry.databaseCleanup === "pending_root_scoped_retention_purge",
  )
    ? "pending_root_scoped_retention_purge"
    : "not_required";
}

try {
  assert(optedIn, "explicit_synthetic_upload_opt_in_required");
  assert(
    options.get("--expected-project-ref") === DEV_REF,
    "expected_development_project_required",
  );
  assert(isAbsolute(options.get("--env") ?? ""), "absolute_env_path_required");
  assert(
    /^[a-f0-9]{40}$/.test(options.get("--deployment-sha") ?? ""),
    "verified_ready_deployment_sha_required",
  );
  preview = new URL(options.get("--preview-url") ?? "");
  assert(
    preview.protocol === "https:" &&
      preview.hostname.endsWith(".vercel.app") &&
      !preview.username &&
      !preview.password &&
      !preview.port &&
      preview.pathname === "/" &&
      !preview.search &&
      !preview.hash,
    "clean_preview_origin_required",
  );
  report.previewHost = preview.hostname;
  report.deploymentCommit = options.get("--deployment-sha");
  const env = parseEnv(await readFile(options.get("--env"), "utf8"));
  endpoint = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  assert(
    endpoint.protocol === "https:" &&
      endpoint.hostname === `${DEV_REF}.supabase.co` &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash,
    "development_project_mismatch",
  );
  const publicKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert(publicKey && env.SUPABASE_SERVICE_ROLE_KEY, "required_dev_supabase_keys_missing");
  const config = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(30000), redirect: "error" }),
    },
  };
  service = createClient(endpoint.href, env.SUPABASE_SERVICE_ROLE_KEY, config);
  async function signIn(role) {
    const client = createClient(endpoint.href, publicKey, {
      ...config,
      auth: { ...config.auth, storageKey: `ra5-smoke-${role}-${runId}` },
    });
    const email = env[`RA4_TEST_${role.toUpperCase()}_EMAIL`];
    const password = env[`RA4_TEST_${role.toUpperCase()}_PASSWORD`];
    assert(email && password, `test_credentials_missing:${role}`);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    assert(!error && data.session?.access_token && data.user?.id, `test_sign_in_failed:${role}`);
    const identity = await app("/api/me", { token: data.session.access_token });
    assert(
      identity.status === 200 &&
        identity.data.role === role &&
        identity.data.userId === data.user.id,
      `preview_test_identity_mismatch:${role}`,
    );
    return { client, id: data.user.id, token: data.session.access_token };
  }
  // Never overwrite an unfinished run's cleanup manifest.
  const prior = await readFile(reportPath, "utf8")
    .then((value) => JSON.parse(value))
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw new Error("existing_report_unreadable");
    });
  assert(
    !prior ||
      prior.cleanup?.database === "verified_removed" ||
      (!prior.receipts?.length && prior.cleanup?.database === "not_required"),
    "unfinished_prior_smoke_requires_cleanup",
  );
  reportInitialized = true;
  report.status = "running";
  await save();
  worker = await signIn("worker");
  admin = await signIn("admin");
  report.testOwnerId = worker.id;
  const manifest = JSON.parse(await readFile(resolve("fixtures/ra5/manifest.json"), "utf8"));
  assert(manifest.synthetic === true, "synthetic_fixture_manifest_required");
  fixtureData = await Promise.all(
    FIXTURES.map(async (fixtureId) => {
      const fixture = manifest.fixtures.find((candidate) => candidate.id === fixtureId);
      assert(
        fixture && fixture.images.length === 1 && /^[a-z0-9-]+\.png$/.test(fixture.images[0]),
        "single_page_synthetic_fixture_required",
      );
      const bytes = await readFile(resolve("fixtures/ra5/images", fixture.images[0]));
      assert(
        bytes.length > 0 &&
          bytes.length <= 10 * 1024 * 1024 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        "invalid_synthetic_fixture_image",
      );
      return { fixture, bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
    }),
  );
  for (const { fixture, bytes, checksum } of fixtureData) {
    const receiptId = randomUUID();
    const missing = await db(
      service.from("receipts").select("id").eq("id", receiptId).maybeSingle(),
      "fresh_receipt_id",
    );
    assert(!missing, "generated_receipt_id_already_exists");
    const entry = {
      fixture: fixture.id,
      receiptId,
      synthetic: true,
      imageSha256: checksum,
      status: "init_pending",
      passed: false,
      databaseCleanup: "pending_root_scoped_retention_purge",
      storageCleanupVerified: false,
    };
    report.receipts.push(entry);
    await save();
    const started = Date.now();
    const initialized = await app("/api/upload-sessions", {
      token: worker.token,
      body: {
        clientSubmissionId: receiptId,
        pages: [
          {
            pageIndex: 0,
            contentType: "image/png",
            originalFilename: `${marker}-${fixture.id}.png`,
          },
        ],
        location: null,
      },
    });
    assert(
      initialized.status === 200 &&
        initialized.data.receiptId === receiptId &&
        initialized.data.status === "upload_pending" &&
        initialized.data.targets?.length === 1,
      "synthetic_upload_session_failed",
    );
    const target = initialized.data.targets[0];
    const signedUrl = new URL(target.uploadUrl);
    assert(
      target.pageIndex === 0 &&
        target.allowedContentType === "image/png" &&
        target.maxBytes >= bytes.length &&
        target.storageKey.startsWith(`${worker.id}/${receiptId}/`) &&
        signedUrl.origin === endpoint.origin &&
        signedUrl.pathname.startsWith(`/storage/v1/object/upload/sign/${BUCKET}/`) &&
        typeof target.token === "string",
      "unexpected_signed_upload_target",
    );
    ownedObjects.set(receiptId, [target.storageKey]);
    entry.status = "upload_pending";
    await save();
    const upload = await worker.client.storage
      .from(BUCKET)
      .uploadToSignedUrl(target.storageKey, target.token, bytes, {
        contentType: "image/png",
        upsert: false,
      });
    assert(!upload.error, "synthetic_signed_upload_failed");
    const confirmed = await app(`/api/receipts/${receiptId}/confirm`, {
      token: worker.token,
      body: { pages: [{ pageIndex: 0, checksum }] },
    });
    assert(
      confirmed.status === 200 &&
        confirmed.data.id === receiptId &&
        ["submitted", "processing", "needs_review"].includes(confirmed.data.status),
      "synthetic_confirmation_failed",
    );
    entry.status = confirmed.data.status;
    await save();
    let receiptStatus;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const current = await app(`/api/receipts/${receiptId}`, { token: worker.token });
      assert(
        current.status === 200 &&
          current.data.id === receiptId &&
          current.data.ownerUserId === worker.id,
        "own_receipt_poll_failed",
      );
      receiptStatus = current.data;
      if (entry.status !== current.data.status) {
        entry.status = current.data.status;
        await save();
        console.log(JSON.stringify({ fixture: fixture.id, status: entry.status }));
      }
      if (current.data.status === "needs_review") break;
      assert(
        ![
          "failed",
          "rejected",
          "rejected_unreadable",
          "duplicate",
          "approved",
          "exporting",
          "exported",
        ].includes(current.data.status),
        "synthetic_receipt_did_not_reach_review",
      );
      await pause(5000);
    }
    assert(
      receiptStatus?.status === "needs_review" && receiptStatus.readability?.readable === true,
      "scoped_confirm_chain_did_not_complete_in_time",
    );
    const rows = await db(
      service
        .from("extractions")
        .select(
          "id,schema_version,generation,model,prompt_version,normalized,lines,raw_text,warnings",
        )
        .eq("receipt_id", receiptId)
        .order("created_at", { ascending: false })
        .limit(2),
      "synthetic_extraction",
    );
    assert(rows.length === 1, "expected_single_extraction_generation");
    const extraction = rows[0];
    const normalized = extraction.normalized;
    assert(
      extraction.schema_version === 1 &&
        extraction.generation === 1 &&
        extraction.raw_text === null &&
        normalized &&
        !Object.hasOwn(normalized, "raw_text") &&
        !Object.hasOwn(normalized, "original_observation"),
      "public_extraction_privacy_or_version_failed",
    );
    const cents = [
      normalized.receipt_total_cents,
      normalized.tax_cents,
      normalized.subtotal_cents,
      normalized.material_total_cents,
      ...normalized.lines.flatMap((line) => [
        line.unit_cost_cents,
        line.extended_cost_cents,
        line.printed_extended_cost_cents,
      ]),
    ];
    assert(
      cents.every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)),
      "normalized_money_not_integer_cents",
    );
    assert(
      normalized.material_total_cents === fixture.expected.material_total_cents &&
        normalized.purchase_date === fixture.expected.purchase_date &&
        normalized.lines.length === fixture.expected.lines.length,
      "synthetic_normalized_values_mismatch",
    );
    for (const [index, expected] of fixture.expected.lines.entries())
      for (const field of ["qty", "unit_cost_cents", "extended_cost_cents"])
        assert(
          normalized.lines[index][field] === expected[field],
          "synthetic_material_line_values_mismatch",
        );
    const projected = await db(
      service
        .from("receipt_lines")
        .select("qty,unit_cost_cents")
        .eq("receipt_id", receiptId)
        .order("sort_index"),
      "synthetic_material_projection",
    );
    const expectedProjection = fixture.expected.lines.filter(
      (line) => line.qty !== null && line.unit_cost_cents !== null,
    );
    assert(
      projected.length === expectedProjection.length &&
        projected.every(
          (line, index) =>
            line.qty === expectedProjection[index].qty &&
            line.unit_cost_cents === expectedProjection[index].unit_cost_cents,
        ),
      "synthetic_material_projection_mismatch",
    );
    const detail = await app(`/api/manager/receipts/${receiptId}`, { token: admin.token });
    assert(
      detail.status === 200 &&
        detail.data.status === "needs_review" &&
        detail.data.draft.lines.length === fixture.expected.lines.length,
      "manager_incomplete_line_preservation_failed",
    );
    if (fixture.id === "lowes-ambiguous-missing") {
      assert(
        detail.data.draft.lines.some((line) => line.unitCost === ""),
        "missing_cost_invented_in_manager_review",
      );
      for (const code of fixture.expected.warningCodes)
        assert(
          extraction.warnings.some((warning) => warning.code === code),
          "missing_expected_review_warning",
        );
    }
    const evidence = await app(
      `/api/manager/receipts/${receiptId}/evidence?extractionId=${extraction.id}`,
      { token: admin.token },
    );
    assert(
      evidence.status === 200 &&
        Array.isArray(evidence.data.evidence) &&
        evidence.data.evidence.length > 0 &&
        evidence.data.evidence.every((field) =>
          Object.keys(field).every((key) =>
            ["field", "text", "page_index", "confidence"].includes(key),
          ),
        ),
      "manager_restricted_field_evidence_failed",
    );
    const workerEvidence = await app(
      `/api/manager/receipts/${receiptId}/evidence?extractionId=${extraction.id}`,
      { token: worker.token },
    );
    assert(workerEvidence.status === 403, "worker_can_access_manager_evidence");
    await assertNoExports(receiptId);
    Object.assign(entry, {
      passed: true,
      status: "needs_review",
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      model: versionSafe(extraction.model),
      promptVersion: versionSafe(extraction.prompt_version),
      schemaVersion: extraction.schema_version,
      generation: extraction.generation,
      extractedLineCount: normalized.lines.length,
      projectedMaterialLineCount: projected.length,
      incompleteLineCount: normalized.lines.filter(
        (line) => line.unit_cost_cents === null || line.qty === null,
      ).length,
      materialTotalCents: normalized.material_total_cents,
      integerCentsVerified: true,
      structuredPrivateEvidenceCount: evidence.data.evidence.length,
      workerEvidenceDenied: true,
      rawTextExcludedFromPublicExtraction: true,
      warningCodes: [
        ...new Set(
          extraction.warnings
            .map((warning) => warning.code)
            .filter((code) => /^[a-z_]{1,80}$/.test(code)),
        ),
      ],
      exportIntentCount: 0,
    });
    await save();
    console.log(
      JSON.stringify({
        fixture: fixture.id,
        passed: true,
        status: entry.status,
        elapsedSeconds: entry.elapsedSeconds,
      }),
    );
  }
  report.status = "checks_passed_cleanup_pending";
} catch (cause) {
  report.status = safeCode(cause) === "preview_access_protected" ? "blocked" : "failed";
  report.reason = safeCode(cause);
  process.exitCode = report.status === "blocked" ? 2 : 1;
} finally {
  if (reportInitialized && service && report.receipts.length) {
    await cleanupObjects();
    if (!report.cleanup.storageVerified) {
      report.cleanup.reason = "root_must_finish_exact_object_cleanup_after_fencing_own_work";
      process.exitCode = 1;
    }
  }
  report.requestCount = appRequests;
  await save();
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      passedFixtures: report.receipts.filter((entry) => entry.passed).length,
      createdReceiptIds: report.receipts.map((entry) => entry.receiptId),
      cleanup: report.cleanup,
      ...(report.reason ? { reason: report.reason } : {}),
      report: reportPath,
    },
    null,
    2,
  ),
);
