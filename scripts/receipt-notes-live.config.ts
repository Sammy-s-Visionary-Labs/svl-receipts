import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["scripts/receipt-notes-live.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
