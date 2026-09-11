import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  outputDir: "../../test-results/ios-webkit",
  use: {
    ...base.use,
    launchOptions: {},
  },
  projects: [
    { name: "Safari", use: { ...devices["Desktop Safari"] } },
    { name: "iPhone Safari", use: { ...devices["iPhone 13"] } },
  ],
});
