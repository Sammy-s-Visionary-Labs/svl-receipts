import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  completeSourceConnection,
  createWorkerBrowser,
  downloadWorkbook,
  NeedsLoginError,
  prepareNotesReport,
  prepareReport,
} from "./browser.mjs";
import {
  calendarDate,
  nextScheduledRun,
  REPORT_URL,
  reportInterval,
  safeError,
  shouldRunScheduled,
  validateWorkbookBytes,
  workerConfig,
} from "./core.mjs";

export async function appRequest(config, path, init = {}, fetchImpl = fetch) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.token}`);
  const response = await fetchImpl(`${config.appUrl}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    const detail = await localErrorMessage(response);
    const message = detail
      ? `The receipt application returned HTTP ${response.status}: ${detail}`
      : `The receipt application returned HTTP ${response.status}. Check the worker token and application server.`;
    throw new Error(safeError(new Error(message.replaceAll(config.token, "[token redacted]"))));
  }
  return response.json();
}

async function localErrorMessage(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed?.error?.message === "string" ? parsed.error.message : null;
  } catch {
    return null;
  }
}

export function postHeartbeat(config, data, fetchImpl) {
  return appRequest(
    config,
    "/api/manager/labor/worker",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
    fetchImpl,
  );
}

export function uploadWorkbook(config, bytes, interval, fetchImpl) {
  validateWorkbookBytes(bytes);
  const body = new FormData();
  body.set(
    "file",
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `Supercrew_Timesheet_${interval.start}_${interval.end}.xlsx`,
  );
  body.set("source", "supercrew");
  body.set("periodStart", interval.start);
  body.set("periodEnd", interval.end);
  return appRequest(config, "/api/manager/labor/import", { method: "POST", body }, fetchImpl);
}

export function uploadPairedWorkbooks(config, bytes, notesBytes, interval, fetchImpl, claim) {
  validateWorkbookBytes(bytes);
  validateWorkbookBytes(notesBytes);
  const body = new FormData();
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  body.set(
    "file",
    new Blob([bytes], { type }),
    `Supercrew_Timesheet_${interval.start}_${interval.end}.xlsx`,
  );
  body.set(
    "notesFile",
    new Blob([notesBytes], { type }),
    `Supercrew_Notes_${interval.start}_${interval.end}.xlsx`,
  );
  body.set("source", "supercrew");
  body.set("notesScope", "daily_timesheet");
  body.set("periodStart", interval.start);
  body.set("periodEnd", interval.end);
  if (claim) {
    body.set("leaseToken", claim.leaseToken);
    body.set("commandId", claim.commandId);
  }
  return appRequest(config, "/api/manager/labor/import", { method: "POST", body }, fetchImpl);
}

export async function acquirePairedReports(
  config,
  interval,
  attempt,
  page,
  context,
  operations = {},
) {
  const prepareTimesheet = operations.prepareReport ?? prepareReport;
  const prepareNotes = operations.prepareNotesReport ?? prepareNotesReport;
  const downloadReport = operations.downloadWorkbook ?? downloadWorkbook;
  const persist = operations.writeFile ?? writeFile;
  const stamp = attempt.getTime();
  const reportPath = join(
    config.reportDir,
    `supercrew-timesheet-${interval.start}-${interval.end}-${stamp}.xlsx`,
  );
  const { download } = await prepareTimesheet(page, interval);
  const bytes = await downloadReport(
    page,
    context,
    download,
    reportPath,
    config.reportDownloadsApproved,
  );
  // Preserve the original before another report can navigate/change source state.
  await persist(reportPath, bytes, { mode: 0o600 });
  const notesPath = join(
    config.reportDir,
    `supercrew-notes-${interval.start}-${interval.end}-${stamp}.xlsx`,
  );
  const notes = await prepareNotes(page, interval);
  if (notes.scope !== "daily_timesheet")
    throw new Error(
      "The Notes Report daily acquisition scope was not verified. Nothing was imported.",
    );
  const notesBytes = await downloadReport(
    page,
    context,
    notes.download,
    notesPath,
    config.reportDownloadsApproved,
  );
  await persist(notesPath, notesBytes, { mode: 0o600 });
  return { bytes, notesBytes };
}

export async function ensurePrivateDirectories(config) {
  process.umask(0o077);
  for (const path of [config.stateDir, config.profileDir, config.reportDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

export async function connectSession(config, commandId, state = {}) {
  await postHeartbeat(config, {
    status: "running",
    lastError: null,
    lastAttemptAt: new Date().toISOString(),
    nextRunAt: null,
  });
  let context;
  try {
    const browser = await createWorkerBrowser(config, false);
    context = browser.context;
    const page = browser.page;
    console.log(
      "Sign in to Supercrew in the isolated browser. Passwords and MFA are entered by you; the development worker never copies your Chrome profile.",
    );
    await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await completeSourceConnection(page);
    const { sync } = await appRequest(config, "/api/manager/labor/worker");
    await postHeartbeat(config, {
      status: "idle",
      lastError: null,
      nextRunAt: nextScheduledRun({ ...sync, status: "idle" }, new Date(), state),
      ...(commandId ? { commandId } : {}),
    });
    console.log(
      "Supercrew session connected. Its isolated browser profile is kept privately in .local/labor-worker.",
    );
  } catch (error) {
    await postHeartbeat(config, {
      status: "needs_login",
      lastError: safeError(error),
      nextRunAt: null,
      ...(commandId ? { commandId } : {}),
    });
    throw error;
  } finally {
    if (context) await context.close();
  }
}

export function idleWorkerHeartbeat(sync, now, state) {
  if (sync.status === "not_connected") return null;
  const status = ["failed", "needs_login"].includes(sync.status) ? sync.status : "idle";
  return {
    status,
    lastError: status === "idle" ? null : (sync.lastError ?? null),
    nextRunAt: state.connectedAt ? nextScheduledRun({ ...sync, status }, now, state) : null,
  };
}

export async function runImport(config, sync, commandId, state = {}) {
  const attempt = new Date();
  state.lastScheduledDate = calendarDate(attempt, sync?.timeZone).date;
  // Persist before contacting the source so a failed or interrupted manual run
  // cannot trigger another automatic export immediately after restart.
  await saveSchedulerState(config, state);
  const interval = reportInterval(
    attempt,
    sync?.lookbackDays ?? 14,
    sync?.timeZone ?? "America/New_York",
  );
  await postHeartbeat(config, {
    status: "running",
    lastError: null,
    lastAttemptAt: attempt.toISOString(),
    nextRunAt: null,
  });
  let context;
  try {
    if (!config.reportDownloadsApproved) {
      throw new Error(
        "Supercrew report storage downloads are not enabled for this worker. Set the approved report-download flag before running.",
      );
    }
    ({ context } = await createWorkerBrowser(config));
    const page = context.pages()[0] ?? (await context.newPage());
    const { bytes, notesBytes } = await acquirePairedReports(
      config,
      interval,
      attempt,
      page,
      context,
    );
    const imported = await uploadPairedWorkbooks(config, bytes, notesBytes, interval);
    const success = new Date().toISOString();
    await postHeartbeat(config, {
      status: "idle",
      lastError: null,
      lastSuccessAt: success,
      nextRunAt: nextScheduledRun(
        { ...sync, status: "idle", lastSuccessAt: success },
        new Date(success),
        state,
      ),
      ...(commandId ? { commandId } : {}),
    });
    console.log(
      `Supercrew ${interval.start} through ${interval.end}: ${imported.duplicate ? "unchanged report" : "imported into development"}.`,
    );
    return imported;
  } catch (error) {
    await postHeartbeat(config, {
      status: error instanceof NeedsLoginError ? "needs_login" : "failed",
      lastError: safeError(error),
      nextRunAt: nextScheduledRun(
        { ...sync, status: error instanceof NeedsLoginError ? "needs_login" : "failed" },
        new Date(),
        state,
      ),
      ...(commandId ? { commandId } : {}),
    });
    throw error;
  } finally {
    if (context) await context.close();
  }
}

async function readSchedulerState(config) {
  try {
    return JSON.parse(await readFile(join(config.stateDir, "scheduler.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(
      "The private scheduler state is unreadable. Inspect .local/labor-worker/scheduler.json before starting another scheduled attempt.",
    );
  }
}

async function saveSchedulerState(config, state) {
  await writeFile(join(config.stateDir, "scheduler.json"), `${JSON.stringify(state)}\n`, {
    mode: 0o600,
  });
}

const WORKER_LOCK_MESSAGES = Object.freeze({
  WORKER_LOCK_ACTIVE: "Another local worker is running. Stop that worker before starting another.",
  WORKER_LOCK_UNVERIFIED:
    "The local worker lock owner could not be verified. Preserve the lock and inspect the local worker setup.",
  WORKER_LOCK_RECOVERY_BUSY:
    "A local worker lock recovery is already recorded. Preserve it and inspect the local worker setup.",
  WORKER_LOCK_SETUP_FAILED:
    "The private local worker lock could not be prepared. Check the local worker setup.",
});

export class WorkerLockError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(WORKER_LOCK_MESSAGES, code) ? code : "WORKER_LOCK_SETUP_FAILED";
    super(WORKER_LOCK_MESSAGES[safeCode]);
    this.name = "WorkerLockError";
    this.code = safeCode;
  }
}

function sameLockFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readWorkerLock(path) {
  let descriptor;
  try {
    const expected = lstatSync(path);
    if (!expected.isFile() || expected.size < 1 || expected.size > 1024)
      throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile() ||
      !sameLockFile(expected, identity) ||
      identity.size < 1 ||
      identity.size > 1024
    )
      throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
    const buffer = Buffer.alloc(1025);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count !== identity.size) throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
    return { identity, content: buffer.subarray(0, count).toString("utf8") };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function workerLockPid(content) {
  let pid;
  if (/^[1-9]\d{0,9}\n?$/.test(content)) pid = Number(content.trim());
  else {
    let record;
    try {
      record = JSON.parse(content);
    } catch {
      throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
    }
    if (
      record?.version !== 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.token)
    )
      throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
    pid = record.pid;
  }
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
  return pid;
}

function unlinkOwnedWorkerLock(path, owned, verifyContent = true) {
  try {
    const current = verifyContent ? readWorkerLock(path) : { identity: lstatSync(path) };
    if (
      sameLockFile(current.identity, owned.identity) &&
      (!verifyContent || current.content === owned.content)
    )
      unlinkSync(path);
  } catch {
    // Unknown, replaced, or unreadable files remain untouched.
  }
}

function createWorkerLock(path, content, writeRecord = writeFileSync) {
  const descriptor = openSync(path, "wx", 0o600);
  let identity;
  let closed = false;
  try {
    identity = fstatSync(descriptor);
    writeRecord(descriptor, content);
    closeSync(descriptor);
    closed = true;
    return { identity, content };
  } catch {
    if (identity) unlinkOwnedWorkerLock(path, { identity }, false);
    throw new WorkerLockError("WORKER_LOCK_SETUP_FAILED");
  } finally {
    if (!closed) {
      try {
        closeSync(descriptor);
      } catch {
        /* Closing a failed setup is best effort. */
      }
    }
  }
}

export async function claimWorker(config, operations = {}) {
  const path = join(config.stateDir, "worker.lock");
  const recoveryPath = `${path}.recovery`;
  const content = `${JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() })}\n`;
  const probeProcess = operations.probeProcess ?? ((pid) => process.kill(pid, 0));
  let owned;
  try {
    try {
      lstatSync(recoveryPath);
      throw new WorkerLockError("WORKER_LOCK_RECOVERY_BUSY");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      owned = createWorkerLock(path, content, operations.writeRecord);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let recovery;
      try {
        recovery = createWorkerLock(recoveryPath, content);
      } catch (error) {
        if (error.code === "EEXIST") throw new WorkerLockError("WORKER_LOCK_RECOVERY_BUSY");
        throw error;
      }
      try {
        const previous = readWorkerLock(path);
        const pid = workerLockPid(previous.content);
        try {
          await probeProcess(pid);
          throw new WorkerLockError("WORKER_LOCK_ACTIVE");
        } catch (error) {
          if (error instanceof WorkerLockError) throw error;
          if (error.code !== "ESRCH") throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
        }
        const current = readWorkerLock(path);
        if (
          !sameLockFile(current.identity, previous.identity) ||
          current.content !== previous.content
        )
          throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
        // The recovery guard serializes stale contenders. A fresh exclusive
        // creator can win after this unlink; its replacement must be preserved.
        unlinkSync(path);
        try {
          owned = createWorkerLock(path, content, operations.writeRecord);
        } catch (error) {
          if (error.code === "EEXIST") throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
          throw error;
        }
      } finally {
        unlinkOwnedWorkerLock(recoveryPath, recovery);
      }
    }
  } catch (error) {
    if (error instanceof WorkerLockError) throw error;
    throw new WorkerLockError("WORKER_LOCK_UNVERIFIED");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    unlinkOwnedWorkerLock(path, owned);
  };
  process.once("exit", release);
  return release;
}

export async function watch(config) {
  const state = await readSchedulerState(config);
  let failures = 0;
  console.log(
    `Development labor worker listening to ${config.appUrl}. No Housecall writes are implemented.`,
  );
  for (;;) {
    try {
      const { sync } = await appRequest(config, "/api/manager/labor/worker");
      const now = new Date();
      if (sync.command && sync.commandId === state.lastCommandId) {
        // A command can survive an uncertain local HTTP heartbeat. Do not run
        // another export/login for the same command ID; a new action makes a new ID.
        await postHeartbeat(config, {
          status: "failed",
          lastError:
            "This command was already attempted. Review the last import and request a new command if needed.",
          commandId: sync.commandId,
          nextRunAt: state.connectedAt
            ? nextScheduledRun({ ...sync, status: "failed" }, now, state)
            : null,
        });
      } else if (sync.command === "connect") {
        state.lastCommandId = sync.commandId;
        await saveSchedulerState(config, state);
        await connectSession(config, sync.commandId, state);
        state.connectedAt = new Date().toISOString();
        await saveSchedulerState(config, state);
      } else if (sync.command === "run") {
        state.lastCommandId = sync.commandId;
        await saveSchedulerState(config, state);
        await runImport(config, sync, sync.commandId, state);
      } else if (shouldRunScheduled(sync, now, state)) {
        await runImport(config, sync, undefined, state);
      } else {
        const heartbeat = idleWorkerHeartbeat(sync, now, state);
        if (heartbeat) await postHeartbeat(config, heartbeat);
      }
      failures = 0;
      await delay(15000);
    } catch (error) {
      failures++;
      console.error(safeError(error));
      // Import/login errors consume their command and schedule interval. Retry only
      // read-only local polling, with a cap of 60 seconds between polls.
      await delay(Math.min(60000, 15000 * 2 ** Math.min(failures - 1, 2)));
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["--connect", "--once", "--watch"].includes(argv[0])) {
    throw new Error("Usage: node scripts/supercrew-worker/worker.mjs --connect | --once | --watch");
  }
  const config = workerConfig();
  await ensurePrivateDirectories(config);
  const release = await claimWorker(config);
  try {
    if (argv[0] === "--connect") {
      const state = await readSchedulerState(config);
      await connectSession(config, undefined, state);
      state.connectedAt = new Date().toISOString();
      await saveSchedulerState(config, state);
      return;
    }
    if (argv[0] === "--watch") return await watch(config);
    const { sync } = await appRequest(config, "/api/manager/labor/worker");
    return await runImport(config, sync, undefined, await readSchedulerState(config));
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
