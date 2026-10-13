import { unlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
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

export async function connectSession(config, commandId) {
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
      nextRunAt: nextScheduledRun({ ...sync, status: "idle" }),
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
    nextRunAt: state.connectedAt ? nextScheduledRun({ ...sync, status }, now) : null,
  };
}

export async function runImport(config, sync, commandId) {
  const attempt = new Date();
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
      nextRunAt: nextScheduledRun({ ...sync, status: "idle" }, new Date(success)),
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
      nextRunAt: nextScheduledRun({
        ...sync,
        status: error instanceof NeedsLoginError ? "needs_login" : "failed",
      }),
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

export async function claimWorker(config) {
  const path = join(config.stateDir, "worker.lock");
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Another development worker owns .local/labor-worker/worker.lock. Stop it before starting another; remove a stale lock only after verifying no worker is running.",
      );
    }
    throw error;
  }
  await file.writeFile(`${process.pid}\n`);
  await file.close();
  const release = () => {
    try {
      unlinkSync(path);
    } catch {
      /* already released */
    }
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
          nextRunAt: state.connectedAt ? nextScheduledRun({ ...sync, status: "failed" }) : null,
        });
      } else if (sync.command === "connect") {
        state.lastCommandId = sync.commandId;
        await saveSchedulerState(config, state);
        await connectSession(config, sync.commandId);
        state.connectedAt = new Date().toISOString();
        await saveSchedulerState(config, state);
      } else if (sync.command === "run") {
        state.lastCommandId = sync.commandId;
        await saveSchedulerState(config, state);
        await runImport(config, sync, sync.commandId);
      } else if (shouldRunScheduled(sync, now, state)) {
        state.lastScheduledDate = calendarDate(now, sync.timeZone).date;
        await saveSchedulerState(config, state);
        await runImport(config, sync);
      } else {
        const heartbeat = idleWorkerHeartbeat(sync, now, state);
        if (heartbeat) await postHeartbeat(config, heartbeat);
      }
      failures = 0;
      await delay(15000);
    } catch (error) {
      failures++;
      console.error(safeError(error));
      // Import/login errors consume their command and scheduled day. Retry only
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
      await connectSession(config);
      const state = await readSchedulerState(config);
      state.connectedAt = new Date().toISOString();
      await saveSchedulerState(config, state);
      return;
    }
    if (argv[0] === "--watch") return await watch(config);
    const { sync } = await appRequest(config, "/api/manager/labor/worker");
    return await runImport(config, sync);
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
