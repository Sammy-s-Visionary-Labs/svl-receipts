/** Bounded Preview API checks: no receipt/category/work writes, queue runs or Housecall calls. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_DEV_REF = "vrtcbrowjnipbldoioyr";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/verify-ra5-preview.mjs --preview-url https://DEPLOYMENT.vercel.app --env /absolute/dev/.env.local --expected-project-ref vrtcbrowjnipbldoioyr [--report docs/ra5-preview-verification.json]",
  );
  console.log(
    "Uses isolated in-memory test-account sign-ins. Only reads and rejected invalid/nonexistent-resource requests; no browser interaction, sign-out, app writes, queue runs, Gemini or Housecall calls.",
  );
  process.exit(0);
}
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (
    !["--preview-url", "--env", "--expected-project-ref", "--report"].includes(args[index]) ||
    !args[index + 1] ||
    args[index + 1].startsWith("--") ||
    options.has(args[index])
  ) {
    console.error("invalid_arguments_use_help");
    process.exit(1);
  }
  options.set(args[index], args[index + 1]);
}
const reportPath = resolve(options.get("--report") ?? "docs/ra5-preview-verification.json");
if (!reportPath.startsWith(`${resolve("docs")}/`)) {
  console.error("report_must_be_inside_workspace_docs");
  process.exit(1);
}
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  targetProjectRef: EXPECTED_DEV_REF,
  previewHost: null,
  mode: "application-read-only",
  status: "not_run",
  checks: [],
  scope:
    "Preview API authorization, empty/missing-resource guards and sanitized response shape. Auth sign-in is the only hosted session operation; no receipt/category/work changes, exports, provider calls, browser changes or global sign-outs.",
  limitation:
    "Does not verify real-vendor accuracy, live Housecall synchronization or successful Preview processing. Existing evaluation contents are inspected only in memory; the report stores counts and versions, never records or credentials.",
};
const failure = (code, blocked = false) => Object.assign(new Error(code), { blocked });
const safeCode = (value) =>
  typeof value === "string" && /^[a-z0-9_:-]{1,120}$/.test(value)
    ? value
    : "preview_verification_failed";
const expect = (condition, code) => {
  if (!condition) throw failure(code);
};
const tokenPattern = /^[a-f0-9]{24}$/;
const valuePattern = /^(?:[a-f0-9]{24}|\d{1,12}(?:\.\d{1,3})?|\[redacted\])$/;
const versionPattern = /^[a-zA-Z0-9._:/-]{1,120}$/;
const allowedFields =
  /^(vendor|purchaseDate|invoiceNumber|ticketNumber|category|referenceTotal|lines\.\d{1,2}\.(description|qty|uom|unitCost|jobId))$/;
const decisions = ["save_draft", "request_clarification", "decline", "mark_duplicate", "approve"];

try {
  const envPath = options.get("--env");
  expect(isAbsolute(envPath ?? ""), "absolute_env_path_required");
  expect(
    options.get("--expected-project-ref") === EXPECTED_DEV_REF,
    "expected_development_project_required",
  );
  const preview = new URL(options.get("--preview-url") ?? "");
  expect(
    preview.protocol === "https:" &&
      preview.hostname.endsWith(".vercel.app") &&
      !preview.port &&
      !preview.username &&
      !preview.password &&
      preview.pathname === "/" &&
      !preview.search &&
      !preview.hash,
    "expected_preview_origin_required",
  );
  report.previewHost = preview.hostname;
  const env = parseEnv(await readFile(envPath, "utf8"));
  const endpoint = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  expect(
    endpoint.protocol === "https:" &&
      endpoint.hostname === `${EXPECTED_DEV_REF}.supabase.co` &&
      !endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash,
    "target_does_not_match_expected_development_project",
  );
  const publicKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  expect(typeof publicKey === "string" && publicKey.length > 0, "public_supabase_key_missing");
  // Check all required credentials without ever logging their values or copying the environment.
  const roles = ["manager", "admin", "worker", "disabled"];
  for (const role of roles)
    for (const field of ["EMAIL", "PASSWORD"])
      expect(
        !!env[`RA4_TEST_${role.toUpperCase()}_${field}`],
        `test_account_configuration_missing:${role}`,
      );
  let requests = 0;
  async function api(path, { token, body } = {}) {
    expect(++requests <= 45, "request_budget_exceeded");
    const response = await fetch(new URL(path, preview), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await response.text();
    expect(bodyText.length <= 2_000_000, "unexpected_response_size");
    const location = response.headers.get("location") ?? "";
    if (
      response.headers.get("x-vercel-mitigated") ||
      (/^30[12378]$/.test(String(response.status)) && /vercel\.com|sso|login/i.test(location)) ||
      (!contentType.includes("application/json") &&
        /vercel authentication|authentication required|vercel security checkpoint|deployment protection/i.test(
          bodyText,
        ))
    ) {
      throw failure("preview_access_protected", true);
    }
    if (!contentType.includes("application/json"))
      throw failure(`non_json_application_response:http${response.status}`);
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw failure("invalid_json_application_response");
    }
    return { status: response.status, data, cache: response.headers.get("cache-control") ?? "" };
  }
  function checkStatus(role, check, result, expectedStatus, expectedCode) {
    expect(
      result.status === expectedStatus,
      `${role}:${check}:expected${expectedStatus}:http${result.status}`,
    );
    if (expectedCode)
      expect(result.data?.error?.code === expectedCode, `${role}:${check}:unexpected_error_code`);
    const row = { role, check, httpStatus: result.status, passed: true };
    report.checks.push(row);
    return row;
  }
  // Access protection is checked before any hosted sign-in. Never follow redirects or bypass protection.
  checkStatus(
    "anonymous",
    "categories",
    await api("/api/manager/categories"),
    401,
    "unauthenticated",
  );
  const anonymousReceiptId = randomUUID();
  const anonymousChecks = [
    ["admin_configuration_invalid", "/api/admin/categories", {}],
    ["evaluation", "/api/admin/intelligence/evaluation", undefined],
    [
      "evidence_missing_receipt",
      `/api/manager/receipts/${anonymousReceiptId}/evidence?extractionId=${randomUUID()}`,
      undefined,
    ],
    ["reextract_missing_receipt", `/api/manager/receipts/${anonymousReceiptId}/reextract`, {}],
    [
      "duplicate_missing_candidate",
      `/api/manager/receipts/${anonymousReceiptId}/duplicates`,
      { decision: "dismiss", candidateId: randomUUID() },
    ],
  ];
  for (const [name, path, body] of anonymousChecks)
    checkStatus("anonymous", name, await api(path, { body }), 401, "unauthenticated");
  for (const role of roles) {
    const client = createClient(endpoint.href, publicKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `ra5-preview-${role}-${randomUUID()}`,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(12000), redirect: "error" }),
      },
    });
    const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({
      email: env[`RA4_TEST_${role.toUpperCase()}_EMAIL`],
      password: env[`RA4_TEST_${role.toUpperCase()}_PASSWORD`],
    });
    expect(
      !signInError && signedIn.session?.access_token && signedIn.user?.id,
      `test_account_sign_in_failed:${role}`,
    );
    const token = signedIn.session.access_token;
    const me = await api("/api/me", { token });
    if (role === "disabled") checkStatus(role, "identity", me, 401, "account_inactive");
    else {
      checkStatus(role, "identity", me, 200);
      expect(
        me.data?.role === role && me.data?.userId === signedIn.user.id,
        `${role}:unexpected_account_identity`,
      );
    }
    const staff = role === "manager" || role === "admin";
    const deniedStatus = role === "disabled" ? 401 : 403;
    const deniedCode = role === "disabled" ? "account_inactive" : "forbidden";
    const receiptId = randomUUID();
    const extractionId = randomUUID();
    const candidateId = randomUUID();
    // A staff read proves the randomized receipt is absent through this exact deployment before any POST.
    if (staff)
      checkStatus(
        role,
        "nonexistent_receipt_precondition",
        await api(`/api/manager/receipts/${receiptId}`, { token }),
        404,
        "not_found",
      );
    const checks = [
      ["categories", "/api/manager/categories", undefined],
      ["admin_configuration_invalid", "/api/admin/categories", {}], // Guaranteed validation rejection before service RPC.
      ["evaluation", "/api/admin/intelligence/evaluation", undefined],
      [
        "evidence_missing_receipt",
        `/api/manager/receipts/${receiptId}/evidence?extractionId=${extractionId}`,
        undefined,
      ],
      ["reextract_missing_receipt", `/api/manager/receipts/${receiptId}/reextract`, {}],
      [
        "duplicate_missing_candidate",
        `/api/manager/receipts/${receiptId}/duplicates`,
        { decision: "dismiss", candidateId },
      ],
    ];
    for (let offset = 0; offset < checks.length; offset += 3) {
      const settled = await Promise.allSettled(
        checks.slice(offset, offset + 3).map(async ([name, path, body]) => {
          const result = await api(path, { token, body });
          if (name === "categories" && staff) {
            const row = checkStatus(role, name, result, 200);
            expect(
              result.cache.includes("no-store") && Array.isArray(result.data?.categories),
              `${role}:category_shape_invalid`,
            );
            expect(
              result.data.categories.length <= 500 &&
                result.data.categories.every(
                  (category) =>
                    Number.isSafeInteger(category.version) &&
                    category.version > 0 &&
                    typeof category.active === "boolean",
                ),
              `${role}:category_versions_invalid`,
            );
            Object.assign(row, {
              count: result.data.categories.length,
              activeCount: result.data.categories.filter((category) => category.active).length,
              configurationVersions: [
                ...new Set(result.data.categories.map((category) => category.version)),
              ].sort((a, b) => a - b),
            });
          } else if (name === "evaluation" && role === "admin") {
            const row = checkStatus(role, name, result, 200);
            expect(
              result.cache.includes("no-store") &&
                result.data?.schemaVersion === 1 &&
                Array.isArray(result.data.records) &&
                result.data.records.length <= 500,
              "admin:evaluation_shape_invalid",
            );
            const keys = [
              "receipt",
              "review",
              "decision",
              "reviewVersion",
              "actor",
              "field",
              "suggested",
              "final",
              "accepted",
              "model",
              "scoringVersion",
              "promptVersion",
            ];
            for (const record of result.data.records) {
              expect(
                record &&
                  Object.keys(record).every((key) => keys.includes(key)) &&
                  tokenPattern.test(record.receipt) &&
                  tokenPattern.test(record.actor) &&
                  (record.review === null || tokenPattern.test(record.review)) &&
                  allowedFields.test(record.field) &&
                  typeof record.accepted === "boolean",
                "admin:evaluation_allowlist_invalid",
              );
              expect(
                [record.suggested, record.final].every(
                  (value) =>
                    value === null || (typeof value === "string" && valuePattern.test(value)),
                ),
                "admin:evaluation_value_not_sanitized",
              );
              expect(
                [record.model, record.scoringVersion, record.promptVersion].every(
                  (value) =>
                    value === null || (typeof value === "string" && versionPattern.test(value)),
                ),
                "admin:evaluation_version_invalid",
              );
              expect(
                (record.decision === null || decisions.includes(record.decision)) &&
                  (record.reviewVersion === null || Number.isSafeInteger(record.reviewVersion)),
                "admin:evaluation_review_metadata_invalid",
              );
            }
            Object.assign(row, {
              schemaVersion: result.data.schemaVersion,
              recordCount: result.data.records.length,
              hasNextPage: typeof result.data.nextPage === "string",
            });
          } else if (name === "admin_configuration_invalid" && role === "admin")
            checkStatus(role, name, result, 400, "invalid_request");
          else if (name === "evidence_missing_receipt" && staff)
            checkStatus(role, name, result, 403, "forbidden");
          else if (name === "reextract_missing_receipt" && staff)
            checkStatus(role, name, result, 409, "conflict");
          else if (name === "duplicate_missing_candidate" && staff)
            checkStatus(role, name, result, 404, "not_found");
          else checkStatus(role, name, result, deniedStatus, deniedCode);
        }),
      );
      const rejected = settled.filter((result) => result.status === "rejected");
      // Every bounded sibling request has settled before stopping on a failed/protected response.
      if (rejected.length) throw rejected[0].reason;
    }
    // No signOut: never revoke the test user's other active sessions. Tokens exist only in this process.
  }
  report.status = "passed";
  report.requestCount = requests;
} catch (error) {
  report.status = error?.blocked ? "blocked" : "failed";
  report.reason = safeCode(error instanceof Error ? error.message : "preview_verification_failed");
  process.exitCode = report.status === "blocked" ? 2 : 1;
}
report.checks.sort((a, b) => `${a.role}:${a.check}`.localeCompare(`${b.role}:${b.check}`));
try {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
} catch {
  console.error("could_not_write_sanitized_preview_report");
  process.exitCode = 1;
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      targetProjectRef: report.targetProjectRef,
      previewHost: report.previewHost,
      passedChecks: report.checks.filter((check) => check.passed).length,
      ...(report.reason ? { reason: report.reason } : {}),
      report: reportPath,
    },
    null,
    2,
  ),
);
