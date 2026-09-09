import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/ra5-gemini-evaluation.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
