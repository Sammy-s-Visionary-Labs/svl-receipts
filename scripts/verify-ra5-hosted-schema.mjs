/** Read-only hosted-dev preflight. Never applies migrations or drains queues. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/verify-ra5-hosted-schema.mjs --env /absolute/dev/.env.local --expected-project-ref VERIFIED_DEV_REF",
  );
  console.log(
    "Checks schema/API boundaries only. No migrations, receipt writes, queue runs, Gemini calls, or Housecall requests.",
  );
  process.exit(0);
}
const option = (key) => args[args.indexOf(key) + 1];
const envPath = args.includes("--env") ? option("--env") : null;
const expectedRef = args.includes("--expected-project-ref")
  ? option("--expected-project-ref")
  : null;
if (!envPath?.startsWith("/") || !/^[a-z0-9]{20}$/.test(expectedRef ?? "")) {
  console.error(
    "Provide an absolute --env path and the independently verified development --expected-project-ref.",
  );
  process.exit(1);
}

try {
  const env = parseEnv(await readFile(envPath, "utf8"));
  const endpoint = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== `${expectedRef}.supabase.co` ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/"
  ) {
    throw new Error("target_does_not_match_expected_development_project");
  }
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!serviceKey || !publicKey) throw new Error("required_supabase_keys_missing");
  const report = [];
  async function request(path, { key = serviceKey, body, profile } = {}) {
    const response = await fetch(new URL(`/rest/v1/${path}`, endpoint), {
      method: body ? "POST" : "GET",
      headers: {
        apikey: key,
        ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
        ...(profile ? { "Accept-Profile": profile } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  }
  const tables = {
    extractions: "id,work_item_id,generation,model,prompt_version,normalized,warnings,usage",
    work_items: "id,generation",
    receipt_categories: "id,label,active,keywords,version,approved_by",
    duplicate_candidates:
      "id,receipt_id,candidate_receipt_id,extraction_id,score,reasons,scoring_version,status",
    receipt_intelligence_feedback:
      "id,review_id,extraction_id,field_path,model,prompt_version,scoring_version",
    job_candidates: "id,extraction_id,source_index,score,reasons,scoring_version",
    manager_job_catalog:
      "id,po_references,service_address,lat,lng,assigned_worker_ids,vendor_history",
  };
  const checks = Object.entries(tables);
  for (let offset = 0; offset < checks.length; offset += 3) {
    await Promise.all(
      checks.slice(offset, offset + 3).map(async ([table, columns]) => {
        const { response, data } = await request(`${table}?select=${columns}&limit=0`);
        if (!response.ok || !Array.isArray(data) || data.length !== 0) {
          const code =
            typeof data?.code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(data.code)
              ? data.code.toLowerCase()
              : "unexpected_response";
          throw new Error(`schema_check_failed:${table}:http${response.status}:${code}`);
        }
        report.push({ check: `schema:${table}`, passed: true });
      }),
    );
  }
  const workId = randomUUID();
  const { response: workResponse, data: work } = await request(
    `work_items?select=id&id=eq.${workId}&limit=1`,
  );
  if (!workResponse.ok || !Array.isArray(work) || work.length !== 0)
    throw new Error("cannot_verify_nonexistent_probe_id");
  const probe = {
    p_work_id: workId,
    p_worker_id: "ra5-readonly-preflight",
    p_generation: 1,
    p_result: {},
    p_model: "preflight",
    p_prompt_version: "preflight",
    p_usage: {},
    p_intelligence: {},
  };
  const result = await request("rpc/record_extraction_result", { body: probe });
  if (result.response.ok || result.data?.message !== "conflict")
    throw new Error("extraction_lease_guard_missing");
  report.push({ check: "missing-lease-rejected", passed: true });
  const denied = await request("rpc/record_extraction_result", { key: publicKey, body: probe });
  if (![401, 403].includes(denied.response.status))
    throw new Error("anonymous_extraction_rpc_boundary_failed");
  report.push({ check: "anonymous-result-write-denied", passed: true });
  const privateEvidence = await request("extraction_evidence?select=extraction_id&limit=0", {
    key: publicKey,
    profile: "receipt_private",
  });
  if (![401, 403, 406].includes(privateEvidence.response.status))
    throw new Error("private_evidence_boundary_failed");
  report.push({ check: "private-evidence-unavailable-to-anonymous-api", passed: true });
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        targetProjectRef: expectedRef,
        mode: "read-only",
        checks: report.sort((a, b) => a.check.localeCompare(b.check)),
        verified:
          "Schema and basic API boundaries only; processing and manager review still require controlled synthetic verification.",
      },
      null,
      2,
    ),
  );
} catch (cause) {
  // Never echo provider payloads, URLs containing credentials, or environment content.
  const code =
    cause instanceof Error && /^[a-z0-9_:-]{1,120}$/.test(cause.message)
      ? cause.message
      : "hosted_preflight_failed";
  console.error(code);
  process.exitCode = 1;
}
