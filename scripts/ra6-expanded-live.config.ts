import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../apps/web", import.meta.url)) } },
  test: {
    include: ["scripts/ra6-expanded-live.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 300_000,
  },
});
