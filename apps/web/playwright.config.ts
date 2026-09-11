import { defineConfig, devices } from "@playwright/test";

const appDirectory = __dirname;
const appPort = Number(process.env.RA27_E2E_PORT ?? 3187);
const authPort = Number(process.env.RA27_E2E_AUTH_PORT ?? 54877);
const baseURL = `http://127.0.0.1:${appPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  outputDir: "../../test-results/ra27",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: [
    {
      command: "node e2e/fixture-server.mjs",
      cwd: appDirectory,
      url: `http://127.0.0.1:${authPort}/health`,
      reuseExistingServer: false,
      env: { RA27_E2E_AUTH_PORT: String(authPort) },
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${appPort}`,
      cwd: appDirectory,
      url: `${baseURL}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_ra27_browser_fixture_only",
        // The local suite must never inherit a real privileged credential.
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_ra27_browser_fixture_only",
        HOUSECALL_API_KEY: "ra6_fixture_only_never_live",
        HOUSECALL_READS_ENABLED: "false",
        HOUSECALL_EXPORT_MODE: "disabled",
        HOUSECALL_ACCESS_MODE: "test_jobs",
        HOUSECALL_TEST_JOB_IDS: "",
        HOUSECALL_TEST_CUSTOMER_IDS: "",
        HOUSECALL_TEST_SESSION_ID: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
