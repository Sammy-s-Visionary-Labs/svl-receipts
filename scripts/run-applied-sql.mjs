import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlFiles = [
  "ra2_applied.sql",
  "ra23_applied.sql",
  "ra25_applied.sql",
  "ra209_applied.sql",
  "ra27_applied.sql",
  "ra4_applied.sql",
  "ra5_applied.sql",
  "ra5_scoped_work_applied.sql",
  "ra6_applied.sql",
  "ra6_jobs_applied.sql",
  "ra6_job_selection_applied.sql",
  "ra6_resolution_applied.sql",
  "ra6_test_session_applied.sql",
  "ra6_role_exports_applied.sql",
].map((name) => join(root, "supabase", "tests", name));
const url = process.env.SVL_APPLIED_DATABASE_URL;

if (!url) {
  console.error("SVL_APPLIED_DATABASE_URL is required to execute applied SQL tests");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
});

try {
  // Hosted monitoring deliberately enables LOGIN (see storage-capacity-runbook.md).
  // Fresh migration replay still requires the default NOLOGIN role.
  await sql`select set_config('svl.test_allow_monitor_login', ${process.env.SVL_APPLIED_ALLOW_MONITOR_LOGIN === "true" ? "true" : "false"}, false)`;
  // Each suite intentionally contains BEGIN, multiple DO blocks, and ROLLBACK.
  // Simple-query mode executes each file as one rollback-only database session.
  for (const sqlFile of sqlFiles) {
    await sql.unsafe(await readFile(sqlFile, "utf8")).simple();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "applied_sql_failed");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
