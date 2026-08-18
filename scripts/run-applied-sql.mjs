import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlFile = join(root, "supabase", "tests", "ra2_applied.sql");
const url = process.env.SVL_APPLIED_DATABASE_URL;

if (!url) {
  console.error("SVL_APPLIED_DATABASE_URL is required to execute supabase/tests/ra2_applied.sql");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
});

try {
  // The suite intentionally contains BEGIN, multiple DO blocks, and ROLLBACK.
  // Simple-query mode executes the file as one rollback-only database session.
  await sql.unsafe(await readFile(sqlFile, "utf8")).simple();
} catch (error) {
  console.error(error instanceof Error ? error.message : "applied_sql_failed");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
