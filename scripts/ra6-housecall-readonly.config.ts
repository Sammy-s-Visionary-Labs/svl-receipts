import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/ra6-housecall-readonly.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 240_000,
  },
});
