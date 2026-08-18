import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlFile = join(root, "supabase", "tests", "ra2_applied.sql");
const url = process.env.SVL_APPLIED_DATABASE_URL;

if (!url) {
  console.error("SVL_APPLIED_DATABASE_URL is required to execute supabase/tests/ra2_applied.sql");
  process.exit(1);
}

const supabaseCommand = process.platform === "win32" ? "supabase.cmd" : "supabase";
const result = spawnSync(supabaseCommand, ["db", "query", "--db-url", url, "--file", sqlFile], {
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
