import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  completeSourceConnection,
  createPortableWorkerBrowser,
  createWorkerBrowser,
  NeedsLoginError,
  verifySignedIn,
} from "./browser.mjs";
import { addCalendarDays, calendarDate, REPORT_URL, safeError, workerConfig } from "./core.mjs";
import { decryptSession, encryptSession, MAX_SESSION_BYTES, sessionKey } from "./session.mjs";
import {
  acquirePairedReports,
  appRequest,
  claimWorker,
  ensurePrivateDirectories,
  uploadPairedWorkbooks,
  WorkerLockError,
} from "./worker.mjs";

const PREFIX = "/api/manager/labor/worker";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RUN_ID = /^[a-zA-Z0-9._:-]{1,160}$/;
const claimFile = (config) => join(config.stateDir, "hosted-claim.json");

class WorkerPollProtocolError extends Error {}
class WorkerCleanupError extends Error {}

/** Expose fixed local setup diagnoses without printing provider/parser details. */
export function publicWorkerFailureMessage(error) {
  if (error instanceof WorkerLockError) return `Supercrew worker could not start: ${error.message}`;
  if (error instanceof WorkerPollProtocolError || error instanceof WorkerCleanupError)
    return error.message;
  if (["EACCES", "EPERM"].includes(error?.code))
    return "Supercrew worker could not access its private local storage. Check the worker folder permissions before restarting.";
  if (["ENOSPC", "EDQUOT"].includes(error?.code))
    return "Supercrew worker has no space available for its private local files. Free disk space before restarting.";
  return "Supercrew worker did not complete. Check the receipt app's Supercrew status and the worker setup configuration.";
}

export function safeWorkerError(error, config, claim) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.token, config.sessionEncryptionKey, claim?.leaseToken])
    if (secret) message = message.replaceAll(secret, "[secret redacted]");
  return safeError(new Error(message));
}

export function validateClaim(claim, now = new Date()) {
  if (!claim || !UUID.test(claim.commandId) || !UUID.test(claim.leaseToken))
    throw new Error("Invalid worker claim; request a fresh command.");
  const { from, to } = claim.period ?? {};
  if (typeof from !== "string" || typeof to !== "string" || from > to)
    throw new Error("Invalid claimed report period.");
  addCalendarDays(from, 0);
  addCalendarDays(to, 0);
  if (
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000 > 30 ||
    to >= calendarDate(now, claim.sync?.timeZone ?? "America/New_York").date
  )
    throw new Error("The claimed report period must cover at most 31 completed dates.");
  return claim;
}

export function workflowRunId(env = process.env) {
  const value =
    env.LABOR_RUN_ID ??
    (env.GITHUB_RUN_ID
      ? `github:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT ?? "1"}`
      : `local:${randomUUID()}`);
  if (!RUN_ID.test(value)) throw new Error("Invalid worker run identifier.");
  return value;
}

export async function preflight(config, runId, fetchImpl = fetch, signal) {
  if (!RUN_ID.test(runId)) throw new Error("Invalid worker run identifier.");
  // Fail configuration before claiming work. This script imports no browser package.
  sessionKey(config.sessionEncryptionKey);
  const { claim } = await appRequest(
    config,
    `${PREFIX}/claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
      signal,
    },
    fetchImpl,
  );
  if (claim === null) return null;
  return validateClaim(claim);
}

export async function saveClaim(config, runId, claim) {
  await ensurePrivateDirectories(config);
  const temporary = join(config.stateDir, `claim-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ version: 1, runId, claim }), { mode: 0o600 });
  await rename(temporary, claimFile(config));
}

export async function loadClaim(config, env = process.env) {
  const bytes = await readFile(claimFile(config));
  if (bytes.length > 16384) throw new Error("Invalid local claim record.");
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid local claim record.");
  }
  if (record.version !== 1 || !RUN_ID.test(record.runId))
    throw new Error("Invalid local claim record.");
  if ((env.LABOR_RUN_ID || env.GITHUB_RUN_ID) && record.runId !== workflowRunId(env))
    throw new Error("The claim belongs to a different worker run.");
  return validateClaim(record.claim);
}

async function sessionRequest(config, method, bytes, leaseToken, fetchImpl = fetch) {
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });
  if (method === "PUT") {
    if (!Number.isSafeInteger(config.sessionVersion) || config.sessionVersion < 0)
      throw new Error("Read the current worker session version before saving it.");
    headers.set("Content-Type", "application/octet-stream");
    headers.set("x-labor-session-version", String(config.sessionVersion));
  }
  if (leaseToken) headers.set("x-labor-lease-token", leaseToken);
  const response = await fetchImpl(`${config.appUrl}${PREFIX}/session`, {
    method,
    headers,
    body: bytes,
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (method === "GET" && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new NeedsLoginError(
      "No portable Supercrew session is connected. Run the isolated session setup.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Private worker session request returned HTTP ${response.status}.`);
  }
  return response;
}

function rememberSessionVersion(config, response) {
  const text = response.headers.get("x-labor-session-version");
  if (!text || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new Error("The private worker session returned an invalid version.");
  config.sessionVersion = Number(text);
}

async function readSessionVersion(config, fetchImpl) {
  try {
    const response = await sessionRequest(config, "GET", undefined, undefined, fetchImpl);
    try {
      rememberSessionVersion(config, response);
    } finally {
      await response.body?.cancel();
    }
  } catch (error) {
    if (!(error instanceof NeedsLoginError)) throw error;
    config.sessionVersion = 0;
  }
}

export async function getSession(config, fetchImpl = fetch) {
  const response = await sessionRequest(config, "GET", undefined, undefined, fetchImpl);
  let reader;
  try {
    rememberSessionVersion(config, response);
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_SESSION_BYTES))
      throw new Error("Private Supercrew session exceeds its storage limit.");
    reader = response.body?.getReader();
    if (!reader) throw new Error("Private Supercrew session is empty.");
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_SESSION_BYTES)
        throw new Error("Private Supercrew session exceeds its storage limit.");
      chunks.push(value);
    }
    return decryptSession(Buffer.concat(chunks), config.sessionEncryptionKey);
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else await response.body?.cancel().catch(() => {});
  }
}

export async function putSession(config, storageState, leaseToken, fetchImpl = fetch) {
  const bytes = encryptSession(storageState, config.sessionEncryptionKey);
  const response = await sessionRequest(config, "PUT", bytes, leaseToken, fetchImpl);
  try {
    rememberSessionVersion(config, response);
  } finally {
    await response.body?.cancel();
  }
}

function postWorker(config, suffix, data, fetchImpl, signal) {
  return appRequest(
    config,
    `${PREFIX}/${suffix}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal,
    },
    fetchImpl,
  );
}

export async function runLeasedImport(config, claim, operations = {}) {
  validateClaim(claim, operations.now?.() ?? new Date());
  sessionKey(config.sessionEncryptionKey);
  const request = operations.fetch ?? fetch;
  const signal = operations.signal;
  const fetchImpl = signal
    ? (url, init = {}) =>
        request(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
        })
    : request;
  const createBrowser = operations.createBrowser ?? createPortableWorkerBrowser;
  const acquire = operations.acquire ?? acquirePairedReports;
  const verify = operations.verify ?? verifySignedIn;
  let resources, timer, timeout, failure;
  let heartbeatBusy = false;
  let finished = false;
  let imported = false;
  const assertActive = () => {
    if (failure) throw failure;
  };
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (error) => {
    if (finished || failure) return;
    failure = error;
    rejectInterrupted(error);
    // Closing Chromium also ends blocked source operations. Server leases reject stale writes.
    void resources?.browser?.close().catch(() => {});
  };
  const stopError = () =>
    new Error(
      "The Supercrew worker was stopped. Review import history before requesting another download.",
    );
  const onAbort = () => interrupt(stopError());
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) failure = stopError();
  const heartbeat = () =>
    postWorker(config, "heartbeat", { leaseToken: claim.leaseToken, status: "running" }, fetchImpl);
  const operation = async () => {
    assertActive();
    await ensurePrivateDirectories(config);
    assertActive();
    await heartbeat();
    assertActive();
    timer = setInterval(async () => {
      if (heartbeatBusy || finished) return;
      heartbeatBusy = true;
      try {
        await heartbeat();
      } catch (error) {
        interrupt(error);
      } finally {
        heartbeatBusy = false;
      }
    }, operations.heartbeatEveryMs ?? 30000);
    timeout = setTimeout(
      () =>
        interrupt(
          new Error(
            "The finite Supercrew run exceeded its eight-minute deadline; review the last import before retrying.",
          ),
        ),
      operations.deadlineMs ?? 480000,
    );
    const state = await getSession(config, fetchImpl);
    assertActive();
    resources = await createBrowser(config, state);
    if (failure) {
      await resources.context.close().catch(() => {});
      await resources.browser?.close().catch(() => {});
      assertActive();
    }
    await resources.page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await verify(resources.page);
    assertActive();
    const interval = { start: claim.period.from, end: claim.period.to };
    const { bytes, notesBytes } = await acquire(
      config,
      interval,
      operations.now?.() ?? new Date(),
      resources.page,
      resources.context,
    );
    assertActive();
    const result = await uploadPairedWorkbooks(
      config,
      bytes,
      notesBytes,
      interval,
      fetchImpl,
      claim,
    );
    imported = true;
    assertActive();
    const refreshed = await resources.context.storageState({ indexedDB: true });
    assertActive();
    await putSession(config, refreshed, claim.leaseToken, fetchImpl);
    assertActive();
    await postWorker(config, "finish", { leaseToken: claim.leaseToken, status: "idle" }, fetchImpl);
    finished = true;
    return result;
  };
  const operationPromise = operation();
  let result, runError;
  let cleanupIncomplete = false;
  try {
    result = await Promise.race([operationPromise, interrupted]);
  } catch (error) {
    finished = true;
    const lastError = safeWorkerError(error, config, claim);
    const warning = imported
      ? `Reports were imported; review import history before retrying. ${lastError}`
      : lastError;
    try {
      await postWorker(
        config,
        "finish",
        {
          leaseToken: claim.leaseToken,
          status: error instanceof NeedsLoginError ? "needs_login" : "failed",
          lastError: warning.slice(0, 500),
        },
        request,
        signal?.aborted ? AbortSignal.timeout(5000) : undefined,
      );
    } catch {
      /* An expired/uncertain lease stays visible for server recovery. */
    }
    runError = new Error(warning, { cause: error });
  } finally {
    finished = true;
    clearInterval(timer);
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await resources?.context?.close().catch(() => {});
    await resources?.browser?.close().catch(() => {});
    // A cancelled browser launch may finish after the interruption. Its failure
    // check above closes that late browser; do not poll for another run meanwhile.
    if (signal || failure) {
      let cleanupTimer;
      const settled = await Promise.race([
        operationPromise.then(
          () => true,
          () => true,
        ),
        new Promise((resolve) => {
          cleanupTimer = setTimeout(() => resolve(false), operations.cleanupDeadlineMs ?? 15000);
        }),
      ]);
      clearTimeout(cleanupTimer);
      cleanupIncomplete = !settled;
    } else operationPromise.catch(() => {});
  }
  if (cleanupIncomplete)
    throw new WorkerCleanupError(
      "The worker could not finish browser cleanup. Stop it before restarting.",
    );
  if (runError) throw runError;
  return result;
}

/** Shared polling never creates commands or downloads without a server lease. */
export async function watchHostedWorker(config, operations = {}) {
  sessionKey(config.sessionEncryptionKey);
  if (!config.reportDownloadsApproved)
    throw new Error("Explicit Supercrew report-download approval is required before watching.");
  const pollEveryMs = operations.pollEveryMs ?? 15000;
  const maxBackoffMs = operations.maxBackoffMs ?? 60000;
  if (
    !Number.isSafeInteger(pollEveryMs) ||
    pollEveryMs < 1 ||
    pollEveryMs > 60000 ||
    !Number.isSafeInteger(maxBackoffMs) ||
    maxBackoffMs < pollEveryMs ||
    maxBackoffMs > 300000
  )
    throw new Error("Invalid Supercrew worker polling interval.");
  const runId = operations.runId ?? workflowRunId();
  if (!RUN_ID.test(runId)) throw new Error("Invalid worker run identifier.");
  const signal = operations.signal;
  if (signal?.aborted) return;
  const request = operations.fetch ?? fetch;
  const runImport = operations.runImport ?? runLeasedImport;
  const sleep = operations.sleep ?? ((ms, stopped) => delay(ms, undefined, { signal: stopped }));
  const log = operations.log ?? console.log;
  const reportError = operations.error ?? console.error;
  await ensurePrivateDirectories(config);
  const release = await claimWorker(config);
  let failures = 0;
  try {
    log("Supercrew worker listening for queued or scheduled work.");
    while (!signal?.aborted) {
      let waitMs = pollEveryMs;
      try {
        const poll = await appRequest(config, PREFIX, { signal }, request);
        if (typeof poll?.claimable !== "boolean")
          throw new WorkerPollProtocolError("The worker poll returned an invalid claimable value.");
        if (signal?.aborted) break;
        if (poll.claimable) {
          const claim = await preflight(config, runId, request, signal);
          if (claim) {
            const result = await runImport(config, claim, { ...operations, signal });
            log(
              result?.duplicate
                ? "Supercrew report pair already recorded."
                : "Supercrew report pair imported.",
            );
          }
        }
        failures = 0;
      } catch (error) {
        if (error instanceof WorkerCleanupError || error instanceof WorkerPollProtocolError)
          throw error;
        if (signal?.aborted) break;
        failures++;
        waitMs = Math.min(maxBackoffMs, pollEveryMs * 2 ** Math.min(failures - 1, 10));
        // Detailed source errors belong only in the manager's private status.
        reportError(
          "Supercrew worker check did not complete. Retrying the application check shortly.",
        );
      }
      if (signal?.aborted) break;
      try {
        await sleep(waitMs, signal);
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  } finally {
    release();
    process.removeListener("exit", release);
  }
}

export async function bootstrapSession(config, operations = {}) {
  sessionKey(config.sessionEncryptionKey);
  await ensurePrivateDirectories(config);
  const release = await claimWorker(config);
  let local, fresh;
  try {
    local = await (operations.createLocalBrowser ?? createWorkerBrowser)(config, false);
    await local.page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log(
      "Sign in normally in the isolated Supercrew browser, including MFA. No passwords or session contents are printed.",
    );
    await (operations.connect ?? completeSourceConnection)(local.page);
    const state = await local.context.storageState({ indexedDB: true });
    // Verify portable authentication in a fresh browser before publishing it.
    fresh = await (operations.createPortableBrowser ?? createPortableWorkerBrowser)(config, state);
    await fresh.page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await (operations.verify ?? verifySignedIn)(fresh.page);
    const portable = await fresh.context.storageState({ indexedDB: true });
    // Read only the version, allowing a human reconnection to replace an expired
    // session or rotate its encryption key without decrypting the prior state.
    await readSessionVersion(config, operations.fetch ?? fetch);
    await putSession(config, portable, undefined, operations.fetch ?? fetch);
    console.log("Encrypted Supercrew session connected. No reports were downloaded.");
  } finally {
    await fresh?.context?.close().catch(() => {});
    await fresh?.browser?.close().catch(() => {});
    await local?.context?.close().catch(() => {});
    release();
  }
}

export function abortClaim(config, claim, fetchImpl = fetch) {
  return postWorker(
    config,
    "finish",
    {
      leaseToken: claim.leaseToken,
      status: "failed",
      lastError:
        "The GitHub worker did not complete. Review the last import before requesting another download.",
    },
    fetchImpl,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = workerConfig(env);
  if (
    argv.length !== 1 ||
    !["--preflight", "--run", "--connect", "--abort", "--watch"].includes(argv[0])
  )
    throw new Error("Usage: hosted.mjs --preflight | --run | --connect | --abort | --watch");
  if (argv[0] === "--watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      return await watchHostedWorker(config, {
        signal: controller.signal,
        runId: workflowRunId(env),
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGHUP", stop);
    }
  }
  if (argv[0] === "--connect") return bootstrapSession(config);
  if (argv[0] === "--abort") return abortClaim(config, await loadClaim(config, env));
  if (argv[0] === "--preflight") {
    const runId = workflowRunId(env);
    const claim = await preflight(config, runId);
    if (claim) await saveClaim(config, runId, claim);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `claimed=${claim !== null}\n`);
    console.log(claim ? "Supercrew work claimed." : "No Supercrew work is due.");
    return;
  }
  const result = await runLeasedImport(config, await loadClaim(config, env));
  console.log(
    result.duplicate
      ? "Supercrew report pair already recorded."
      : "Supercrew report pair imported.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Public workflow logs must never contain provider/parser errors: those can
    // include customer names, report filenames, hours, or source row details.
    // A leased failure records its bounded, secret-redacted detail privately.
    console.error(publicWorkerFailureMessage(error));
    process.exitCode = 1;
  });
}
