import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../apps/web", import.meta.url)) } },
  test: {
    include: ["scripts/ra5-local-pipeline-smoke.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
