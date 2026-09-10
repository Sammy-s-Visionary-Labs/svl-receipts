import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "ra6-final-review.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: "list",
  outputDir: "../.local/ra6/final-browser-results",
  use: { baseURL: "http://127.0.0.1:3196", viewport: { width: 1500, height: 1050 }, trace: "off" },
});
