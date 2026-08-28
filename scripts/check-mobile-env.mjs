import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const mobileRoot = resolve(import.meta.dirname, "../apps/mobile");
const envFiles = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];
const serverOnlyNames = new Set([
  "AI_API_KEY",
  "AI_PROVIDER",
  "CRON_SECRET",
  "HOUSECALL_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]);

const violations = [];
for (const fileName of envFiles) {
  const path = resolve(mobileRoot, fileName);
  if (!existsSync(path)) {
    continue;
  }
  const names = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1])
    .filter((name) => name && serverOnlyNames.has(name));
  for (const name of new Set(names)) {
    violations.push(`${fileName}: ${name}`);
  }
}

if (violations.length > 0) {
  console.error(
    [
      "Server-only variables are not allowed in apps/mobile env files.",
      ...violations.map((violation) => `- ${violation}`),
      "Move them to apps/web/.env.local. No values were printed.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
