import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createServiceLogger,
  MAX_SERVICE_LOG_BYTES,
  parseProductionEnvironment,
  parseServiceArguments,
  runMacService,
} from "./mac-service.mjs";

const ENV = {
  LABOR_APP_URL: "https://fixture.example",
  LABOR_APP_HOST: "fixture.example",
  LABOR_WORKER_TOKEN: "SYNTHETIC-PRIVATE-SERVICE-TOKEN-123456789",
  LABOR_SESSION_ENCRYPTION_KEY: "a1".repeat(32),
  SUPERCREW_REPORT_DOWNLOADS_APPROVED: "1",
};
const serialize = (env = ENV) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "svl-mac-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "production.env");
  const runtime = join(root, "runtime");
  await writeFile(config, serialize(), { mode: 0o600 });
  return { root, config, runtime, args: ["--config", config, "--runtime", runtime] };
}
const messages = (bytes) =>
  bytes
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(25));

test("production environment parsing allows exactly validated worker settings without expansion", () => {
  const parsed = parseProductionEnvironment(`# private settings\n${serialize()}`);
  assert.deepEqual(parsed, ENV);
  assert.equal(Object.isFrozen(parsed), true);
  for (const override of [
    { NODE_OPTIONS: "--require=ATTACKER" },
    { HOUSECALL_API_KEY: "UNRELATED-SECRET" },
    { LABOR_APP_URL: "http://fixture.example" },
    { LABOR_APP_URL: "https://other.example" },
    { LABOR_APP_URL: "https://fixture.example/path" },
    { LABOR_APP_URL: "https://fixture.example?secret=HIDDEN" },
    { LABOR_APP_URL: "https://localhost", LABOR_APP_HOST: "localhost" },
    { LABOR_APP_URL: "https://secret:password@fixture.example" },
    { LABOR_WORKER_TOKEN: "short" },
    { LABOR_WORKER_TOKEN: `${ENV.LABOR_WORKER_TOKEN}\nsecret` },
    { LABOR_SESSION_ENCRYPTION_KEY: "bad" },
    { SUPERCREW_REPORT_DOWNLOADS_APPROVED: "true" },
  ])
    assert.throws(() => parseProductionEnvironment(serialize({ ...ENV, ...override })));
  const missing = { ...ENV };
  delete missing.LABOR_APP_HOST;
  assert.throws(() => parseProductionEnvironment(serialize(missing)));
  assert.throws(() => parseProductionEnvironment("a".repeat(16385)));
});

test("service arguments require explicit absolute configuration and runtime paths", () => {
  assert.deepEqual(
    parseServiceArguments([
      "--connect",
      "--config",
      "/private/config.env",
      "--runtime",
      "/private/runtime",
    ]),
    { connect: true, config: "/private/config.env", runtime: "/private/runtime" },
  );
  for (const args of [
    [],
    ["--config", "relative", "--runtime", "/tmp/worker"],
    ["--config", "/tmp/env", "--runtime", "/"],
    ["--config", "/tmp/env", "--runtime", "/tmp/env"],
    ["--config", "/tmp/env", "--runtime", "/tmp/run", "--config", "/tmp/other"],
    ["--config", "/tmp/env", "--runtime", "/tmp/run", "--connect", "--connect"],
  ])
    assert.throws(() => parseServiceArguments(args));
});

test("watch service aborts on signals, removes handlers and writes only private fixed event text", async (t) => {
  const f = await fixture(t);
  const signals = new EventEmitter();
  await runMacService(f.args, {
    signals,
    watch: async (config, operations) => {
      assert.equal(config.appUrl, ENV.LABOR_APP_URL);
      assert.equal(config.token, ENV.LABOR_WORKER_TOKEN);
      assert.equal(config.stateDir, join(f.runtime, ".local/labor-worker"));
      assert.equal(config.sessionEncryptionKey, ENV.LABOR_SESSION_ENCRYPTION_KEY);
      assert.match(operations.runId, /^mac:[a-f0-9-]{36}$/);
      operations.log("Supercrew worker listening for queued or scheduled work.");
      operations.log(`SECRET unknown event ${ENV.LABOR_WORKER_TOKEN}`);
      operations.error(
        new Error(`SECRET https://private.invalid ${ENV.LABOR_SESSION_ENCRYPTION_KEY}`),
      );
      signals.emit("SIGTERM");
      assert.equal(operations.signal.aborted, true);
    },
  });
  const contents = await readFile(join(f.runtime, "service.log"), "utf8");
  assert.deepEqual(messages(contents), [
    "Supercrew service started.",
    "Supercrew worker listening for queued or scheduled work.",
    "Supercrew worker reported an update.",
    "Supercrew worker check did not complete. Retrying the application check shortly.",
    "Supercrew service stopped.",
  ]);
  assert.equal(contents.includes("SECRET"), false);
  for (const path of [f.runtime, join(f.runtime, ".local"), join(f.runtime, ".local/labor-worker")])
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.runtime, "service.log"))).mode & 0o777, 0o600);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    assert.equal(signals.listenerCount(signal), 0);
});

test("connection uses a fresh private profile and removes it after generic bootstrap completion", async (t) => {
  const f = await fixture(t);
  const profiles = [];
  for (let run = 0; run < 2; run++)
    await runMacService([...f.args, "--connect"], {
      bootstrap: async (config) => {
        assert.equal(config.stateDir, join(f.runtime, ".local/labor-worker"));
        assert.ok(config.profileDir.startsWith(`${config.stateDir}/connect-`));
        assert.equal((await stat(config.profileDir)).mode & 0o777, 0o700);
        await writeFile(join(config.profileDir, "TEST-session"), "PRIVATE", { mode: 0o600 });
        profiles.push(config.profileDir);
      },
      watch: async () => assert.fail("Connection must not start the watcher"),
    });
  assert.notEqual(profiles[0], profiles[1]);
  for (const profile of profiles) await assert.rejects(stat(profile), { code: "ENOENT" });
  const contents = await readFile(join(f.runtime, "service.log"), "utf8");
  assert.equal(contents.includes("PRIVATE"), false);
  assert.equal(
    messages(contents).filter(
      (line) => line === "Encrypted Supercrew session connected. No reports were downloaded.",
    ).length,
    2,
  );
});

test("bootstrap and watch failures never surface raw provider errors or secret values", async (t) => {
  for (const connect of [false, true]) {
    const f = await fixture(t);
    const failure = async () => {
      throw new Error(`SECRET ${ENV.LABOR_WORKER_TOKEN} https://private.invalid`);
    };
    await assert.rejects(
      runMacService([...f.args, ...(connect ? ["--connect"] : [])], {
        watch: failure,
        bootstrap: failure,
      }),
      (error) =>
        !error.message.includes("SECRET") && !error.message.includes(ENV.LABOR_WORKER_TOKEN),
    );
    const contents = await readFile(join(f.runtime, "service.log"), "utf8");
    assert.equal(contents.includes("SECRET"), false);
    assert.ok(contents.includes("Supercrew service did not complete."));
    assert.equal(
      (await readdir(join(f.runtime, ".local/labor-worker"))).some((name) =>
        name.startsWith("connect-"),
      ),
      false,
    );
  }
});

test("bounded service logging rotates one private backup and rejects arbitrary event text", async (t) => {
  const f = await fixture(t);
  await mkdir(f.runtime, { mode: 0o700 });
  await writeFile(join(f.runtime, "service.log"), "x".repeat(MAX_SERVICE_LOG_BYTES - 4), {
    mode: 0o644,
  });
  await writeFile(join(f.runtime, "service.log.1"), "older", { mode: 0o644 });
  const logger = createServiceLogger(f.runtime, () => new Date("2026-10-29T00:00:00Z"));
  await logger.event("started");
  assert.equal((await stat(join(f.runtime, "service.log.1"))).size, MAX_SERVICE_LOG_BYTES - 4);
  await writeFile(join(f.runtime, "service.log"), "y".repeat(MAX_SERVICE_LOG_BYTES + 100));
  await logger.event("stopped");
  assert.equal((await stat(join(f.runtime, "service.log.1"))).size, MAX_SERVICE_LOG_BYTES);
  assert.deepEqual((await readdir(f.runtime)).sort(), ["service.log", "service.log.1"]);
  for (const file of ["service.log", "service.log.1"])
    assert.equal((await stat(join(f.runtime, file))).mode & 0o777, 0o600);
  await assert.rejects(logger.event(`SECRET ${ENV.LABOR_WORKER_TOKEN}`));
  await logger.flush();
  assert.equal((await readFile(join(f.runtime, "service.log"), "utf8")).includes("SECRET"), false);
});

test("service rejects readable-by-others config and symlink files before starting work", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const operations = { watch: async () => calls++ };
  await chmod(f.config, 0o644);
  await assert.rejects(runMacService(f.args, operations));
  await chmod(f.config, 0o600);
  const linkedConfig = join(f.root, "linked.env");
  await symlink(f.config, linkedConfig);
  await assert.rejects(
    runMacService(["--config", linkedConfig, "--runtime", f.runtime], operations),
  );
  await mkdir(f.runtime, { mode: 0o700 });
  const protectedFile = join(f.root, "protected");
  await writeFile(protectedFile, "UNCHANGED", { mode: 0o600 });
  await symlink(protectedFile, join(f.runtime, "service.log"));
  await assert.rejects(runMacService(f.args, operations));
  assert.equal(await readFile(protectedFile, "utf8"), "UNCHANGED");
  assert.equal(calls, 0);
});
