import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { workerConfig } from "./core.mjs";
import { bootstrapSession, watchHostedWorker } from "./hosted.mjs";
import { sessionKey } from "./session.mjs";

const ENV_KEYS = [
  "LABOR_APP_URL",
  "LABOR_APP_HOST",
  "LABOR_WORKER_TOKEN",
  "LABOR_SESSION_ENCRYPTION_KEY",
  "SUPERCREW_REPORT_DOWNLOADS_APPROVED",
];
const MAX_ENV_BYTES = 16 * 1024;
export const MAX_SERVICE_LOG_BYTES = 1024 * 1024;
const FAILURE =
  "Supercrew service could not complete. Check its private setup and the app's worker status.";
const EVENTS = Object.freeze({
  started: "Supercrew service started.",
  stopped: "Supercrew service stopped.",
  failed: "Supercrew service did not complete. Check the app's worker status.",
  listening: "Supercrew worker listening for queued or scheduled work.",
  imported: "Supercrew report pair imported.",
  duplicate: "Supercrew report pair already recorded.",
  retry: "Supercrew worker check did not complete. Retrying the application check shortly.",
  update: "Supercrew worker reported an update.",
  connecting: "Supercrew session connection started in an isolated browser.",
  connected: "Encrypted Supercrew session connected. No reports were downloaded.",
});
const WORKER_EVENTS = new Map([
  [EVENTS.listening, "listening"],
  [EVENTS.imported, "imported"],
  [EVENTS.duplicate, "duplicate"],
  [EVENTS.retry, "retry"],
]);

/** No I/O or inherited environment: installer and service share this exact preflight. */
export function parseProductionEnvironment(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_ENV_BYTES)
    throw new Error("The private production environment is missing or too large.");
  let env;
  try {
    env = parseEnv(text);
  } catch {
    throw new Error("The private production environment could not be parsed.");
  }
  if (
    Object.keys(env).some((key) => !ENV_KEYS.includes(key)) ||
    ENV_KEYS.some((key) => typeof env[key] !== "string" || !env[key])
  )
    throw new Error(
      "The production environment must contain only the five required worker settings.",
    );
  try {
    if (new URL(env.LABOR_APP_URL).protocol !== "https:") throw new Error();
    const config = workerConfig(env);
    if (new URL(config.appUrl).hostname !== env.LABOR_APP_HOST) throw new Error();
    if (!/^[\x21-\x7e]{32,4096}$/.test(config.token)) throw new Error();
    sessionKey(config.sessionEncryptionKey);
    if (!config.reportDownloadsApproved) throw new Error();
  } catch {
    throw new Error(
      "Production worker settings require an exact HTTPS host, private token/key, and approved downloads.",
    );
  }
  return Object.freeze(Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]])));
}

export function parseServiceArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--connect" && !args.connect) {
      args.connect = true;
      continue;
    }
    if (
      !["--config", "--runtime"].includes(key) ||
      args[key.slice(2)] !== undefined ||
      typeof argv[i + 1] !== "string" ||
      !isAbsolute(argv[i + 1])
    )
      throw new Error("Usage: mac-service.mjs --config ABSENV --runtime ABSSTATE [--connect]");
    args[key.slice(2)] = resolve(argv[++i]);
  }
  if (
    !args.config ||
    !args.runtime ||
    args.config === args.runtime ||
    args.runtime === parse(args.runtime).root
  )
    throw new Error("Usage: mac-service.mjs --config ABSENV --runtime ABSSTATE [--connect]");
  return args;
}

function owned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

async function readPrivateEnvironment(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (
      !stats.isFile() ||
      !owned(stats) ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > MAX_ENV_BYTES
    )
      throw new Error("The production environment must be an owned private file.");
    return parseProductionEnvironment(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || !owned(stats))
    throw new Error("Private service directory unavailable.");
  await chmod(path, 0o700);
}

async function existingPrivateFile(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || !owned(stats)) throw new Error("Private service log unavailable.");
    await chmod(path, 0o600);
    if (stats.size > MAX_SERVICE_LOG_BYTES) {
      const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        await file.truncate(MAX_SERVICE_LOG_BYTES);
      } finally {
        await file.close();
      }
      return { size: MAX_SERVICE_LOG_BYTES };
    }
    return stats;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Only fixed event labels enter this bounded, serialized log. Never error messages. */
export function createServiceLogger(runtime, now = () => new Date()) {
  const path = join(runtime, "service.log");
  const rotated = `${path}.1`;
  let queue = Promise.resolve();
  return {
    event(name) {
      if (!Object.hasOwn(EVENTS, name)) return Promise.reject(new Error("Unknown service event."));
      queue = queue.then(async () => {
        const line = `${now().toISOString()} ${EVENTS[name]}\n`;
        const stats = await existingPrivateFile(path);
        await existingPrivateFile(rotated);
        if (stats && stats.size + Buffer.byteLength(line) > MAX_SERVICE_LOG_BYTES)
          await rename(path, rotated);
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const current = await file.stat();
          if (!current.isFile() || !owned(current))
            throw new Error("Private service log unavailable.");
          await file.chmod(0o600);
          await file.writeFile(line);
        } finally {
          await file.close();
        }
      });
      return queue;
    },
    flush: () => queue,
  };
}

/** Prepare/install is external. This runner touches only its explicit private runtime. */
export async function runMacService(argv = process.argv.slice(2), operations = {}) {
  const args = parseServiceArguments(argv);
  const env = await readPrivateEnvironment(args.config);
  const config = workerConfig(env, args.runtime);
  const oldMask = process.umask(0o077);
  const controller = new AbortController();
  const signals = operations.signals ?? process;
  const stop = () => controller.abort();
  let logger,
    profile,
    loggingFailed = false;
  const report = (event) => {
    void logger.event(event).catch(() => {
      loggingFailed = true;
      controller.abort();
    });
  };
  try {
    await privateDirectory(args.runtime);
    await privateDirectory(join(args.runtime, ".local"));
    await privateDirectory(config.stateDir);
    logger = createServiceLogger(args.runtime, operations.now);
    if (args.connect) {
      // The existing bootstrap owns the same worker.lock for its entire lifetime.
      // The installer must boot out the watcher before invoking --connect.
      profile = await mkdtemp(join(config.stateDir, "connect-"));
      await chmod(profile, 0o700);
      await logger.event("connecting");
      // bootstrapSession prints only its two fixed generic sign-in/result messages.
      await (operations.bootstrap ?? bootstrapSession)({ ...config, profileDir: profile });
      await logger.event("connected");
    } else {
      signals.once("SIGINT", stop);
      signals.once("SIGTERM", stop);
      signals.once("SIGHUP", stop);
      await logger.event("started");
      await (operations.watch ?? watchHostedWorker)(config, {
        signal: controller.signal,
        runId: `mac:${randomUUID()}`,
        log: (message) => report(WORKER_EVENTS.get(message) ?? "update"),
        error: () => report("retry"),
      });
      await logger.flush();
      if (loggingFailed) throw new Error(FAILURE);
      await logger.event("stopped");
    }
  } catch {
    await logger?.event("failed").catch(() => {});
    throw new Error(FAILURE);
  } finally {
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
    signals.removeListener("SIGHUP", stop);
    process.umask(oldMask);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMacService().catch(() => {
    console.error(FAILURE);
    process.exitCode = 1;
  });
}
