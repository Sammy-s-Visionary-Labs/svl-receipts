import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "ra6-expanded-review.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../.local/ra6/expanded-browser-results",
  use: { baseURL: "http://127.0.0.1:3196", viewport: { width: 1500, height: 1050 }, trace: "off" },
});
