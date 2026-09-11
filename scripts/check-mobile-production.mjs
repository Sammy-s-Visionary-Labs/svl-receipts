import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function checkProductionMobileEnvironment(env) {
  if (!["production", "production-install"].includes(env.EAS_BUILD_PROFILE)) return;
  const expected = {
    EXPO_PUBLIC_API_URL: "https://svl-receipts-web.vercel.app",
    EXPO_PUBLIC_SUPABASE_URL: "https://ouyhvzvtjntbtxpmeeyj.supabase.co",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== value) throw new Error(`Production build has an incorrect ${name}.`);
  }
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!key?.startsWith("sb_publishable_")) {
    throw new Error("Production mobile builds require the production publishable Supabase key.");
  }
  if (env.EXPO_NO_DOTENV !== "1") {
    throw new Error("Production builds must disable local dotenv overrides.");
  }
}

function checkProductionArchive() {
  // An EAS archive must not carry a developer's local environment into Metro.
  const mobileRoot = new URL("../apps/mobile/", import.meta.url);
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    try {
      readFileSync(new URL(name, mobileRoot));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Remove apps/mobile/${name} from the production build archive.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkProductionMobileEnvironment(process.env);
  if (["production", "production-install"].includes(process.env.EAS_BUILD_PROFILE)) {
    checkProductionArchive();
  }
  console.log("Mobile build environment checks passed.");
}
