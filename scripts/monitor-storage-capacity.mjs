import { appendFile } from "node:fs/promises";
import postgres from "postgres";
import {
  buildCapacityEvaluation,
  buildCapacityReport,
  decideIssueAction,
} from "./storage-capacity-core.mjs";

const LIVE_MARKER = "<!-- svl-storage-capacity-alert -->";
const TEST_MARKER = "<!-- svl-storage-capacity-test-alert -->";
const FAILURE_MARKER = "<!-- svl-storage-capacity-monitor-failure -->";
const LEVEL_MARKER = (level) => `<!-- svl-storage-level:${level} -->`;
const quotaBytes = numberFromEnvironment("SVL_STORAGE_QUOTA_BYTES", 1_000_000_000);
const quotaScope = process.env.SVL_STORAGE_QUOTA_SCOPE || "shared";
const testUsagePercent = optionalNumberFromEnvironment("SVL_STORAGE_TEST_USAGE_PERCENT");

try {
  assertGithubConfiguration();
  const snapshots = await Promise.all([
    readSnapshot("development", process.env.SVL_DEV_DATABASE_URL),
    readSnapshot("production", process.env.SVL_PROD_DATABASE_URL),
  ]);
  const evaluation = buildCapacityEvaluation({
    snapshots,
    quotaBytes,
    quotaScope,
    testUsagePercent,
  });
  const report = buildCapacityReport(evaluation);
  console.log(report);
  await writeStepSummary(report);
  await syncCapacityIssue(evaluation, report);
  await resolveFailureIssue();
} catch {
  console.error("Storage capacity monitor failed without exposing connection details.");
  await syncFailureIssue().catch(() => undefined);
  process.exitCode = 1;
}

async function readSnapshot(environment, databaseUrl) {
  if (!databaseUrl) throw new Error(`${environment}_database_url_missing`);
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 5,
  });
  try {
    const [row] = await sql`select * from svl_ops.storage_capacity_snapshot()`;
    if (!row) throw new Error("storage_snapshot_missing");
    return {
      environment,
      storageBytes: numeric(row.storage_bytes),
      objectCount: numeric(row.object_count),
      averageObjectBytes: numeric(row.average_object_bytes),
      confirmedPageBytes: numeric(row.confirmed_page_bytes),
      confirmedPageCount: numeric(row.confirmed_page_count),
      averageConfirmedPageBytes: numeric(row.average_confirmed_page_bytes),
      confirmedReceiptCount: numeric(row.confirmed_receipt_count),
      averageConfirmedReceiptBytes: numeric(row.average_confirmed_receipt_bytes),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function syncCapacityIssue(evaluation, report) {
  if (!githubEnabled()) return;
  const marker = evaluation.synthetic ? TEST_MARKER : LIVE_MARKER;
  const title = evaluation.synthetic
    ? "[RA-209 TEST] Storage capacity alert verification"
    : "[RA-209] Storage capacity alert";
  const existing = await findIssue(marker);
  const previousLevel = levelFromBody(existing?.body);
  const action = decideIssueAction(previousLevel, evaluation.level);

  if (action === "none") return;
  if (action === "resolve") {
    if (existing) {
      await updateIssue(existing.number, {
        state: "closed",
        body: `${marker}\n${LEVEL_MARKER("normal")}\n${report}`,
      });
      await commentOnIssue(
        existing.number,
        "Storage usage returned below the 70% warning threshold. Closing this alert.",
      );
    }
    return;
  }

  const body = `${marker}\n${LEVEL_MARKER(evaluation.level)}\n${report}`;
  if (!existing) {
    await createIssue({ title, body });
    return;
  }
  await updateIssue(existing.number, { title, body, state: "open", assignees: alertAssignees() });
  if (action === "escalate" || action === "downgrade") {
    await commentOnIssue(
      existing.number,
      `Storage alert changed from **${previousLevel}** to **${evaluation.level}**.`,
    );
  }
}

async function syncFailureIssue() {
  if (!githubEnabled()) return;
  const existing = await findIssue(FAILURE_MARKER);
  const body = `${FAILURE_MARKER}\n## Storage monitor failed\n\nThe scheduled aggregate snapshot could not be collected. No connection details or receipt identifiers are included.\n\nCheck the workflow secrets, monitor-role login, migration state, and Supabase availability.\n\nRunbook: \`docs/storage-capacity-runbook.md\``;
  if (existing) await updateIssue(existing.number, { body, state: "open" });
  else
    await createIssue({
      title: "[RA-209] Storage capacity monitor failed",
      body,
      assign: false,
    });
}

async function resolveFailureIssue() {
  if (!githubEnabled()) return;
  const existing = await findIssue(FAILURE_MARKER);
  if (existing?.state === "open") {
    await updateIssue(existing.number, { state: "closed" });
    await commentOnIssue(
      existing.number,
      "The monitor completed successfully again. Closing this incident.",
    );
  }
}

async function findIssue(marker) {
  const issues = await githubRequest(`/issues?state=all&per_page=100`);
  return (
    issues.find(
      (issue) =>
        !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker),
    ) ?? null
  );
}

async function createIssue({ title, body, assign = true }) {
  return githubRequest("/issues", {
    method: "POST",
    body: JSON.stringify({ title, body, ...(assign ? { assignees: alertAssignees() } : {}) }),
  });
}

async function updateIssue(number, changes) {
  return githubRequest(`/issues/${number}`, { method: "PATCH", body: JSON.stringify(changes) });
}

async function commentOnIssue(number, body) {
  return githubRequest(`/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function githubRequest(path, init = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    },
  );
  if (!response.ok) throw new Error(`github_api_${response.status}`);
  return response.status === 204 ? null : response.json();
}

function levelFromBody(body) {
  if (typeof body !== "string") return null;
  return body.match(/<!-- svl-storage-level:(normal|warning|high|critical) -->/)?.[1] ?? null;
}

function githubEnabled() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
}

function assertGithubConfiguration() {
  if (githubEnabled() && !process.env.SVL_STORAGE_ALERT_ASSIGNEE?.trim()) {
    throw new Error("storage_alert_assignee_missing");
  }
}

function alertAssignees() {
  const assignee = process.env.SVL_STORAGE_ALERT_ASSIGNEE?.trim();
  return assignee ? [assignee] : [];
}

function numeric(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("storage_snapshot_value_invalid");
  return parsed;
}

function numberFromEnvironment(name, fallback) {
  const raw = process.env[name];
  return raw ? numeric(raw) : fallback;
}

function optionalNumberFromEnvironment(name) {
  const raw = process.env[name]?.trim();
  return raw ? numeric(raw) : null;
}

async function writeStepSummary(report) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
