import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("..", import.meta.url));
const port = "3197";
const authPort = "54887";
const env = {
  ...process.env,
  RA27_E2E_AUTH_PORT: authPort,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_ra27_browser_fixture_only",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_ra27_browser_fixture_only",
  HOUSECALL_API_KEY: "field_preview_only_never_live",
  HOUSECALL_READS_ENABLED: "false",
  HOUSECALL_EXPORT_MODE: "disabled",
  HOUSECALL_ACCESS_MODE: "test_jobs",
  HOUSECALL_TEST_JOB_IDS: "",
  HOUSECALL_TEST_CUSTOMER_IDS: "",
  HOUSECALL_TEST_SESSION_ID: "",
  NEXT_TELEMETRY_DISABLED: "1",
};
// This preview uses a loopback auth/storage fixture. No application auth bypass,
// hosted credentials, or production data is used. Uploaded sample data stays in RAM.
const fixture = spawn(process.execPath, ["e2e/fixture-server.mjs"], {
  cwd: directory,
  env,
  stdio: "inherit",
});
const web = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", port], {
  cwd: directory,
  env,
  stdio: "inherit",
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  fixture.kill("SIGTERM");
  web.kill("SIGTERM");
}
fixture.on("exit", stop);
web.on("exit", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`Local sample preview: http://127.0.0.1:${port}/login?next=/field`);
console.log("Preview account: worker@example.invalid / fixture-only");
