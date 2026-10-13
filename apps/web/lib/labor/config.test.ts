import { describe, expect, it } from "vitest";
import {
  laborDevelopmentEnabled,
  laborFeatureEnabled,
  laborLocalPreviewEnabled,
  laborUsesSupabase,
  localDevelopmentDatabaseAllowed,
} from "./config";

describe("labor development isolation", () => {
  it("cannot be enabled in a production runtime even if preview flags are copied", () => {
    expect(
      laborDevelopmentEnabled({ NODE_ENV: "production", LABOR_DEVELOPMENT_ENABLED: "1" }),
    ).toBe(false);
  });
  it("requires the explicit production feature flag and always uses shared persistence", () => {
    const env = {
      NODE_ENV: "production" as const,
      LABOR_DEVELOPMENT_ENABLED: "1",
      LABOR_LOCAL_PREVIEW: "1",
      LABOR_PERSISTENCE: "filesystem",
    };
    expect(laborFeatureEnabled(env)).toBe(false);
    expect(laborFeatureEnabled({ ...env, LABOR_ENABLED: "1" })).toBe(true);
    expect(laborUsesSupabase(env)).toBe(true);
    expect(laborLocalPreviewEnabled(env)).toBe(false);
  });
  it("allows preview identities only for a local development filesystem ledger", () => {
    const env = {
      NODE_ENV: "development" as const,
      LABOR_DEVELOPMENT_ENABLED: "1",
      LABOR_LOCAL_PREVIEW: "1",
    };
    expect(laborFeatureEnabled(env)).toBe(true);
    expect(laborLocalPreviewEnabled(env)).toBe(true);
    expect(laborLocalPreviewEnabled({ ...env, LABOR_PERSISTENCE: "supabase" })).toBe(false);
    expect(laborLocalPreviewEnabled({ ...env, LABOR_DEVELOPMENT_ENABLED: "0" })).toBe(false);
  });
  it("rejects missing or malformed development database URLs", () => {
    for (const url of [
      undefined,
      "bad URL",
      "https://remote.example.test",
      "http://127.0.0.1.remote.example.test",
    ]) {
      expect(
        localDevelopmentDatabaseAllowed({
          NODE_ENV: "development",
          LABOR_DEVELOPMENT_ENABLED: "1",
          NEXT_PUBLIC_SUPABASE_URL: url,
        }),
      ).toBe(false);
    }
  });
  it("does not allow a hosted production database into the development receipt adapter", () => {
    expect(
      localDevelopmentDatabaseAllowed({
        NODE_ENV: "development",
        LABOR_DEVELOPMENT_ENABLED: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://production-test.supabase.co",
      }),
    ).toBe(false);
    expect(
      localDevelopmentDatabaseAllowed({
        NODE_ENV: "development",
        LABOR_DEVELOPMENT_ENABLED: "1",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      }),
    ).toBe(true);
  });
});
