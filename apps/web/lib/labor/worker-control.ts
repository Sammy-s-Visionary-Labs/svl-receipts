import type { LaborSyncState } from "./contract";

export const LABOR_WORKER_LEASE_MS = 15 * 60 * 1000;
export const LABOR_WORKER_RECOVERY_DELAY_MS = 60 * 1000;
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
  workerCatchup?: LaborWorkerCatchup | null;
};
export type LaborWorkerCatchup = {
  nextFrom: string;
  to: string;
  /** Null means wait for a new manual command or the next configured interval. */
  nextClaimAt: string | null;
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
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(result.getTime()) ||
    result.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid Supercrew schedule date");
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function nextScheduledDate(state: LaborWorkerControlState, now: Date) {
  const { sync } = state;
  if (!Number.isInteger(sync.hour) || sync.hour < 0 || sync.hour > 23)
    throw new Error("Invalid Supercrew schedule hour");
  const intervalDays = sync.intervalDays ?? 1;
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365)
    throw new Error("Supercrew download interval must be 1–365 days");
  const anchors = [];
  if (state.lastScheduledDate) anchors.push(addDays(state.lastScheduledDate, 0));
  if (sync.lastSuccessAt)
    anchors.push(workerCalendar(new Date(sync.lastSuccessAt), sync.timeZone).date);
  const latest = anchors.sort().at(-1);
  return latest ? addDays(latest, intervalDays) : workerCalendar(now, sync.timeZone).date;
}

export function getClaimPeriod(sync: LaborSyncState, now: Date) {
  if (!Number.isInteger(sync.lookbackDays) || sync.lookbackDays < 1 || sync.lookbackDays > 31)
    throw new Error("Invalid Supercrew report lookback");
  const today = workerCalendar(now, sync.timeZone).date;
  return { from: addDays(today, -sync.lookbackDays), to: addDays(today, -1) };
}

function catchupPeriod(state: LaborWorkerControlState, now: Date, refreshTarget: boolean) {
  if (!state.workerCatchup) {
    const rolling = getClaimPeriod(state.sync, now);
    const afterCoverage = state.sync.coverageThrough
      ? addDays(state.sync.coverageThrough, 1)
      : rolling.from;
    state.workerCatchup = {
      nextFrom: afterCoverage < rolling.from ? afterCoverage : rolling.from,
      to: rolling.to,
      nextClaimAt: null,
    };
  } else if (refreshTarget) {
    // A new explicit request or cadence retry also includes dates completed
    // while this download was paused or awaiting attention.
    const yesterday = addDays(workerCalendar(now, state.sync.timeZone).date, -1);
    if (yesterday > state.workerCatchup.to) state.workerCatchup.to = yesterday;
  }
  const { nextFrom, to } = state.workerCatchup;
  addDays(nextFrom, 0);
  addDays(to, 0);
  if (nextFrom > to || to >= workerCalendar(now, state.sync.timeZone).date)
    throw new Error("Invalid Supercrew catch-up period");
  const end = addDays(nextFrom, 30);
  return { from: nextFrom, to: end < to ? end : to };
}

function commitWorkerCoverage(state: LaborWorkerControlState, lease: LaborWorkerLease) {
  if (!lease.imported) return;
  const previous = state.sync.coverageThrough;
  if (previous) {
    addDays(previous, 0);
    if (lease.period.from > addDays(previous, 1))
      throw new Error("Worker import would leave a gap in Supercrew coverage");
  }
  if (!previous || lease.period.to > previous) state.sync.coverageThrough = lease.period.to;
  if (state.workerCatchup) {
    state.workerCatchup.nextFrom = addDays(lease.period.to, 1);
    if (state.workerCatchup.nextFrom > state.workerCatchup.to) state.workerCatchup = null;
  }
}

function nextHourlyGate(now: Date) {
  const next = new Date(now);
  next.setUTCMinutes(17, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

/** Calendar due time is independent of how often the selected worker checks. */
export function nextWorkerRun(state: LaborWorkerControlState, now: Date) {
  const sync = state.sync;
  if (!sync.enabled || !["idle", "failed"].includes(sync.status)) return null;
  if (state.workerCatchup?.nextClaimAt) {
    if (!Number.isFinite(Date.parse(state.workerCatchup.nextClaimAt)))
      throw new Error("Invalid Supercrew catch-up gate");
    return state.workerCatchup.nextClaimAt;
  }
  const date = nextScheduledDate(state, now);
  const anchor = Date.parse(`${date}T${String(sync.hour).padStart(2, "0")}:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: sync.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let skippedHour: string | null = null;
  // Civil-time matching supports fractional UTC offsets, the first repeated
  // fall hour, and the first actual full hour after a skipped spring hour.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = new Date(anchor + offset * 60000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    if (`${parts.year}-${parts.month}-${parts.day}` !== date || Number(parts.minute) !== 0)
      continue;
    if (Number(parts.hour) === sync.hour) return candidate.toISOString();
    if (Number(parts.hour) > sync.hour && !skippedHour) skippedHour = candidate.toISOString();
  }
  if (skippedHour) return skippedHour;
  throw new Error("Could not determine the next Supercrew schedule time");
}

export function recoverExpiredLaborLease(state: LaborWorkerControlState, now: Date) {
  const lease = state.workerLease;
  if (!lease || Date.parse(lease.expiresAt) > now.getTime()) return false;
  // Older leases may predate persisted catch-up state. Recover their exact
  // acquisition period, never infer completion from an attempt timestamp.
  if (!state.workerCatchup && !lease.imported)
    state.workerCatchup = { nextFrom: lease.period.from, to: lease.period.to, nextClaimAt: null };
  commitWorkerCoverage(state, lease);
  if (state.workerCatchup)
    state.workerCatchup.nextClaimAt = new Date(
      now.getTime() + LABOR_WORKER_RECOVERY_DELAY_MS,
    ).toISOString();
  state.workerLease = null;
  if (state.sync.commandId === lease.commandId) {
    state.sync.command = null;
    state.sync.commandId = null;
  }
  state.sync.status = "failed";
  state.sync.lastError = lease.imported
    ? "Previous worker stopped after importing reports. Committed dates are retained; any remaining dates resume after a short delay when recurring downloads are enabled."
    : "Previous worker stopped before completing its import. Its pending dates resume after a short delay when recurring downloads are enabled, or with a new manual request.";
  state.sync.nextRunAt = nextWorkerRun(state, now);
  return true;
}

/** Read-only polling hint. An expired lease needs one claim request to recover it. */
export function workerClaimAvailable(state: LaborWorkerControlState, now: Date): boolean {
  if (state.workerLease) return Date.parse(state.workerLease.expiresAt) <= now.getTime();
  if (state.sync.status === "running" || state.sync.command === "connect") return false;
  if (state.sync.command === "run") return true;
  if (!state.sync.enabled || !["idle", "failed"].includes(state.sync.status)) return false;
  if (state.workerCatchup?.nextClaimAt)
    return Date.parse(state.workerCatchup.nextClaimAt) <= now.getTime();
  const local = workerCalendar(now, state.sync.timeZone);
  const date = nextScheduledDate(state, now);
  return date < local.date || (date === local.date && local.hour >= state.sync.hour);
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
  if (!workerClaimAvailable(state, now)) return null;
  const manual = state.sync.command === "run";
  const local = workerCalendar(now, state.sync.timeZone);
  const commandId = manual ? state.sync.commandId : ids.commandId;
  if (!commandId || !uuid.test(commandId)) throw new Error("Invalid queued worker command ID");
  const period = catchupPeriod(state, now, manual || !state.workerCatchup?.nextClaimAt);
  if (state.workerCatchup) state.workerCatchup.nextClaimAt = null;
  state.workerLease = {
    commandId,
    leaseToken: ids.leaseToken,
    runId,
    period,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LABOR_WORKER_LEASE_MS).toISOString(),
    imported: false,
  };
  // Any export attempt consumes the interval, including failed/manual attempts.
  // This prevents a failing download from restarting at every hourly gate.
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
  commitWorkerCoverage(state, lease);
  if (state.workerCatchup)
    state.workerCatchup.nextClaimAt = status === "idle" ? nextHourlyGate(now) : null;
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
