import { afterEach, describe, expect, it, vi } from "vitest";
import { readSmallJson, requireEmailImporter } from "./config";

afterEach(() => vi.unstubAllEnvs());
describe("email ingestion boundary", () => {
  it("is disabled until configured", () => {
    vi.stubEnv("EMAIL_IMPORT_SECRET", "");
    expect(() => requireEmailImporter(new Request("https://test/api/email-imports"))).toThrow(
      "not configured",
    );
  });
  it("accepts only its dedicated secret", () => {
    vi.stubEnv("EMAIL_IMPORT_SECRET", "s".repeat(40));
    vi.stubEnv("EMAIL_IMPORT_OWNER_ID", "91000000-0000-4000-8000-000000000003");
    expect(() =>
      requireEmailImporter(
        new Request("https://test", { headers: { authorization: "Bearer unrelated-cron-secret" } }),
      ),
    ).toThrow("authentication");
    expect(
      requireEmailImporter(
        new Request("https://test", { headers: { authorization: `Bearer ${"s".repeat(40)}` } }),
      ).ownerId,
    ).toContain("91000000");
  });
  it("bounds the body even without content-length", async () => {
    await expect(
      readSmallJson(new Request("https://test", { method: "POST", body: "x".repeat(5000) })),
    ).rejects.toThrow("too large");
  });
});
