import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionMobileEnvironment } from "./check-mobile-production.mjs";

const production = {
  EAS_BUILD_PROFILE: "production-install",
  EXPO_PUBLIC_API_URL: "https://svl-receipts-web.vercel.app",
  EXPO_PUBLIC_SUPABASE_URL: "https://ouyhvzvtjntbtxpmeeyj.supabase.co",
  EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_fixture",
  EXPO_NO_DOTENV: "1",
};

test("permits production configuration and leaves development builds independent", () => {
  assert.doesNotThrow(() => checkProductionMobileEnvironment(production));
  assert.doesNotThrow(() => checkProductionMobileEnvironment({ EAS_BUILD_PROFILE: "development" }));
});

test("rejects a test API, wrong database, server key, or local dotenv override", () => {
  for (const [name, value] of Object.entries({
    EXPO_PUBLIC_API_URL: "https://svl-receipts-ra6-test-svl1.vercel.app",
    EXPO_PUBLIC_SUPABASE_URL: "https://vrtcbrowjnipbldoioyr.supabase.co",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_fixture",
    EXPO_NO_DOTENV: "0",
  })) {
    assert.throws(() => checkProductionMobileEnvironment({ ...production, [name]: value }));
  }
});
