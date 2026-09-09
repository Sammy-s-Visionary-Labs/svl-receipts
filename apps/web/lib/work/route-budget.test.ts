import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_LEASE_SECONDS } from "@svl/domain";
import { describe, expect, it } from "vitest";
import { EXTRACTION_PROVIDER_TIMEOUT_MS } from "./extraction";
import { READABILITY_PROVIDER_TIMEOUT_MS } from "./runner";

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(path) : entry.name === "route.ts" ? [path] : [];
  });
}

describe("serverless AI work route budgets", () => {
  it("gives every AI kick/cron route preparation and persistence time inside its lease", () => {
    const routes = routeFiles(fileURLToPath(new URL("../../app/api", import.meta.url)))
      .map((path) => ({ path, source: readFileSync(path, "utf8") }))
      .filter(({ source }) =>
        /runWorkBatch\s*\(|runReceiptWork\s*\(|kickWork\s*\(\s*["'](?:extract|readability)["']/.test(
          source,
        ),
      );
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const { path, source } of routes) {
      // Next deployment metadata requires a statically analyzable literal export.
      // after() receives this same deadline; it does not get a fresh budget.
      const duration = Number(source.match(/export const maxDuration\s*=\s*(\d+)\s*;/)?.[1]);
      expect(duration, path).toBeGreaterThanOrEqual(
        (EXTRACTION_PROVIDER_TIMEOUT_MS + READABILITY_PROVIDER_TIMEOUT_MS) / 1000 + 30,
      );
      expect(duration, path).toBeLessThan(WORK_LEASE_SECONDS);
    }
  });
});
