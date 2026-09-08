import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/ra5-fixture-intelligence.test.ts"], environment: "node" },
});
