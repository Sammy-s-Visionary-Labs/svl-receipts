import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { localAppUrl, workerConfig } from "./core.mjs";
import { sessionKey } from "./session.mjs";

// The worker and Chromium need runtime settings, not the website's provider
// credentials. Keep this explicit: NODE_OPTIONS can preload env files or code.
const WORKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "PLAYWRIGHT_BROWSERS_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "LABOR_APP_HOST",
  "LABOR_WORKER_TOKEN",
  "LABOR_SESSION_ENCRYPTION_KEY",
  "LABOR_RUN_ID",
  "SUPERCREW_REPORT_DOWNLOADS_APPROVED",
];

function workerEnvironment(env, appUrl) {
  const result = { LABOR_APP_URL: appUrl };
  for (const key of WORKER_ENV_KEYS) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  return result;
}

export function localConfig(env, cwd) {
  const appUrl = localAppUrl(env.LABOR_APP_URL ?? "http://127.0.0.1:3150");
  const config = workerConfig({ ...env, LABOR_APP_URL: appUrl }, cwd);
  sessionKey(config.sessionEncryptionKey);
  if (!config.reportDownloadsApproved)
    throw new Error("Set SUPERCREW_REPORT_DOWNLOADS_APPROVED=1 in the private labor environment.");
  return config;
}

export async function appReady(config, fetchImpl = fetch, signal) {
  let response;
  try {
    response = await fetchImpl(`${config.appUrl}/api/manager/labor/worker`, {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
    });
  } catch {
    if (signal?.aborted) throw signal.reason;
    return false;
  }
  try {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "The local app does not accept this worker credential. Check the private labor environment.",
      );
    if (!response.ok) return false;
    const body = await response.json();
    if (!body.sync || typeof body.claimable !== "boolean")
      throw new Error(
        "The local app needs the shared-worker polling update before starting downloads.",
      );
    return true;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

function launch(spawnImpl, args, options) {
  const child = spawnImpl(process.execPath, args, options);
  const handle = { child, finished: false, done: null };
  handle.done = new Promise((resolve) => {
    child.once("exit", (code) => {
      handle.finished = true;
      resolve(code ?? 1);
    });
    child.once("error", () => {
      handle.finished = true;
      resolve(1);
    });
  });
  return handle;
}

async function stop(handle) {
  if (!handle || handle.finished) return;
  handle.child.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      handle.done,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          if (!handle.finished) handle.child.kill("SIGKILL");
          resolve();
        }, 30000);
        timer.unref?.();
      }),
    ]);
    await handle.done;
  } finally {
    clearTimeout(timer);
  }
}

/** Owns only children it starts; an already running matching site is left open. */
export async function runLocal(argv = [], env = process.env, cwd = process.cwd(), operations = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--worker-only"))
    throw new Error("Usage: local.mjs [--worker-only]");
  const config = localConfig(env, cwd);
  const controller = new AbortController();
  const signals = operations.signals ?? process;
  const spawnImpl = operations.spawn ?? spawn;
  const probe = operations.appReady ?? appReady;
  const sleep = operations.delay ?? delay;
  const log = operations.log ?? console.log;
  const warn = operations.warn ?? console.error;
  const now = operations.now ?? Date.now;
  const childOptions = {
    cwd,
    env: { ...env, LABOR_APP_URL: config.appUrl },
    stdio: "inherit",
  };
  let web;
  let worker;
  let stopping = false;
  const interrupt = () => {
    stopping = true;
    controller.abort(new Error("Local labor processes stopped."));
  };
  signals.once("SIGINT", interrupt);
  signals.once("SIGTERM", interrupt);
  signals.once("SIGHUP", interrupt);
  try {
    let ready = await probe(config, operations.fetch, controller.signal);
    if (!ready && argv[0] !== "--worker-only") {
      const url = new URL(config.appUrl);
      web = launch(
        spawnImpl,
        [
          join(cwd, "node_modules/next/dist/bin/next"),
          "dev",
          "apps/web",
          "--webpack",
          "--hostname",
          url.hostname === "[::1]" ? "::1" : url.hostname,
          "--port",
          url.port || "80",
        ],
        childOptions,
      );
      web.done.then(() => {
        if (!stopping) controller.abort(new Error("The local website stopped."));
      });
    }
    const deadline = now() + 90000;
    while (!ready) {
      controller.signal.throwIfAborted();
      if (now() >= deadline)
        throw new Error(
          "The local labor app is not ready. Check its startup output and labor environment.",
        );
      await sleep(1000, undefined, { signal: controller.signal });
      ready = await probe(config, operations.fetch, controller.signal);
    }
    controller.signal.throwIfAborted();
    log(`Labor Hours: ${config.appUrl}/labor-hours`);
    log(
      "Starting the Supercrew queue worker. Keep this terminal open; Ctrl+C stops its owned processes.",
    );
    worker = launch(spawnImpl, [join(cwd, "scripts/supercrew-worker/hosted.mjs"), "--watch"], {
      ...childOptions,
      env: workerEnvironment(env, config.appUrl),
    });
    let onAbort;
    try {
      const stopped = new Promise((resolve) => {
        onAbort = () => resolve();
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      await Promise.race([worker.done, stopped]);
      if (!stopping && controller.signal.aborted) throw controller.signal.reason;
      if (!stopping) {
        const message =
          "This local Supercrew queue worker is not running and cannot process queued downloads. Another configured worker may still handle them. Check the worker setup message above before restarting this worker with npm run dev:labor-watch. No automatic restart was attempted.";
        if (!web) throw new Error(message);
        warn(`${message} The website remains available at ${config.appUrl}. Ctrl+C stops it.`);
        // A worker setup failure must not take the manager's website offline.
        // Keep ownership until explicit shutdown or the website itself exits.
        await stopped;
        if (!stopping && controller.signal.aborted) throw controller.signal.reason;
      }
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    await stop(worker);
    await stop(web);
    signals.removeListener("SIGINT", interrupt);
    signals.removeListener("SIGTERM", interrupt);
    signals.removeListener("SIGHUP", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocal(process.argv.slice(2)).catch((error) => {
    // Only messages generated here are public; never emit worker credentials or provider stacks.
    console.error(error.message);
    process.exitCode = 1;
  });
}
