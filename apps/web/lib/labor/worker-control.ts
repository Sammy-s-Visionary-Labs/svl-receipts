import type { LaborSyncState } from "./contract";

export const LABOR_WORKER_LEASE_MS = 15 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type LaborWorkerLease = {
  commandId: string;
  leaseToken: string;
  runId: string;
  period: { from: string; to: string };
  claimedAt: string;
  expiresAt: string;
  imported: boolean;
};
export type LaborWorkerControlState = {
  sync: LaborSyncState;
  workerLease?: LaborWorkerLease | null;
  lastScheduledDate?: string | null;
};
export type LaborWorkerClaim = {
  commandId: string;
  leaseToken: string;
  period: { from: string; to: string };
  sync: LaborSyncState;
};

export function workerCalendar(now: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

function addDays(date: string, days: number) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function getClaimPeriod(sync: LaborSyncState, now: Date) {
  if (!Number.isInteger(sync.lookbackDays) || sync.lookbackDays < 1 || sync.lookbackDays > 31)
    throw new Error("Invalid Supercrew report lookback");
  const today = workerCalendar(now, sync.timeZone).date;
  return { from: addDays(today, -sync.lookbackDays), to: addDays(today, -1) };
}

/** The hosted gate runs at minute 17 UTC each hour and claims the first due local hour. */
export function nextWorkerRun(state: LaborWorkerControlState, now: Date) {
  const sync = state.sync;
  if (!sync.enabled || !["idle", "failed"].includes(sync.status)) return null;
  if (!Number.isInteger(sync.hour) || sync.hour < 0 || sync.hour > 23)
    throw new Error("Invalid Supercrew schedule hour");
  const lastSuccessDate = sync.lastSuccessAt
    ? workerCalendar(new Date(sync.lastSuccessAt), sync.timeZone).date
    : null;
  const candidate = new Date(now);
  candidate.setUTCMinutes(17, 0, 0);
  if (candidate <= now) candidate.setUTCHours(candidate.getUTCHours() + 1);
  for (let hour = 0; hour < 72; hour++) {
    const local = workerCalendar(candidate, sync.timeZone);
    if (
      local.hour >= sync.hour &&
      local.date !== state.lastScheduledDate &&
      local.date !== lastSuccessDate
    )
      return candidate.toISOString();
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  throw new Error("Could not determine the next Supercrew worker gate");
}

export function recoverExpiredLaborLease(state: LaborWorkerControlState, now: Date) {
  const lease = state.workerLease;
  if (!lease || Date.parse(lease.expiresAt) > now.getTime()) return false;
  state.workerLease = null;
  if (state.sync.commandId === lease.commandId) {
    state.sync.command = null;
    state.sync.commandId = null;
  }
  state.sync.status = "failed";
  state.sync.lastError = lease.imported
    ? "Previous worker stopped after importing reports. Review import history before requesting another download."
    : "Previous worker stopped before completing its import. Request another download after checking the last import.";
  state.sync.nextRunAt = nextWorkerRun(state, now);
  return true;
}

export function claimWorker(
  state: LaborWorkerControlState,
  runId: string,
  now: Date,
  ids: { commandId: string; leaseToken: string },
): LaborWorkerClaim | null {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(runId)) throw new Error("Invalid worker run ID");
  if (!uuid.test(ids.commandId) || !uuid.test(ids.leaseToken))
    throw new Error("Invalid worker claim IDs");
  recoverExpiredLaborLease(state, now);
  if (state.workerLease || state.sync.status === "running" || state.sync.command === "connect")
    return null;
  const manual = state.sync.command === "run";
  const local = workerCalendar(now, state.sync.timeZone);
  if (!manual) {
    if (
      !state.sync.enabled ||
      !["idle", "failed"].includes(state.sync.status) ||
      !Number.isInteger(state.sync.hour) ||
      state.sync.hour < 0 ||
      state.sync.hour > 23 ||
      local.hour < state.sync.hour ||
      state.lastScheduledDate === local.date ||
      (state.sync.lastSuccessAt &&
        workerCalendar(new Date(state.sync.lastSuccessAt), state.sync.timeZone).date === local.date)
    )
      return null;
  }
  const commandId = manual ? state.sync.commandId : ids.commandId;
  if (!commandId || !uuid.test(commandId)) throw new Error("Invalid queued worker command ID");
  const period = getClaimPeriod(state.sync, now);
  state.workerLease = {
    commandId,
    leaseToken: ids.leaseToken,
    runId,
    period,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LABOR_WORKER_LEASE_MS).toISOString(),
    imported: false,
  };
  // Any export attempt consumes automatic work for its day; manual retries stay explicit.
  state.lastScheduledDate = local.date;
  state.sync.command = "run";
  state.sync.commandId = commandId;
  state.sync.status = "running";
  state.sync.lastAttemptAt = now.toISOString();
  state.sync.workerHeartbeatAt = now.toISOString();
  state.sync.nextRunAt = null;
  state.sync.lastError = null;
  return { commandId, leaseToken: ids.leaseToken, period, sync: { ...state.sync } };
}

export function assertWorkerLease(state: LaborWorkerControlState, leaseToken: string, now: Date) {
  if (
    !uuid.test(leaseToken) ||
    !state.workerLease ||
    state.workerLease.leaseToken !== leaseToken ||
    state.workerLease.commandId !== state.sync.commandId ||
    state.sync.status !== "running" ||
    !Number.isFinite(Date.parse(state.workerLease.expiresAt)) ||
    Date.parse(state.workerLease.expiresAt) <= now.getTime()
  )
    throw new Error("Stale worker lease; request a fresh command");
  return state.workerLease;
}

export function heartbeatWorker(state: LaborWorkerControlState, leaseToken: string, now: Date) {
  const lease = assertWorkerLease(state, leaseToken, now);
  lease.expiresAt = new Date(now.getTime() + LABOR_WORKER_LEASE_MS).toISOString();
  state.sync.workerHeartbeatAt = now.toISOString();
  return { ...state.sync };
}

export function finishWorker(
  state: LaborWorkerControlState,
  leaseToken: string,
  status: "idle" | "needs_login" | "failed",
  lastError: string | null | undefined,
  now: Date,
) {
  const lease = assertWorkerLease(state, leaseToken, now);
  if (!["idle", "needs_login", "failed"].includes(status))
    throw new Error("Invalid worker finish status");
  if (lastError != null && (typeof lastError !== "string" || lastError.length > 500))
    throw new Error("Invalid worker error");
  if (status === "idle" && !lease.imported)
    throw new Error("Worker cannot report success before paired import commits");
  state.sync.status = status;
  state.sync.lastError =
    status === "idle" ? null : (lastError ?? "Supercrew worker needs attention");
  state.sync.workerHeartbeatAt = now.toISOString();
  if (status === "idle") state.sync.lastSuccessAt = now.toISOString();
  state.sync.command = null;
  state.sync.commandId = null;
  state.workerLease = null;
  state.sync.nextRunAt = nextWorkerRun(state, now);
  return { ...state.sync };
}
