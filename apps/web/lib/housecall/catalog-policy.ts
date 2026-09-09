export const HOUSECALL_JOB_STALE_MS = 26 * 60 * 60 * 1000;

export function housecallCatalogJobIsStale(row: Record<string, unknown>, now = Date.now()) {
  if (row.source !== "housecall") return false;
  const synced = typeof row.synced_at === "string" ? Date.parse(row.synced_at) : NaN;
  return !Number.isFinite(synced) || synced > now + 60_000 || now - synced > HOUSECALL_JOB_STALE_MS;
}

export function housecallJobWindow(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
) {
  const days = (key: string, fallback: number) => {
    const raw = env[key];
    if (!raw) return fallback;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 365)
      throw new Error(`invalid_housecall_job_window:${key}`);
    return parsed;
  };
  return {
    recentSince: new Date(
      now - days("HOUSECALL_ACTIVE_LOOKBACK_DAYS", 30) * 86_400_000,
    ).toISOString(),
    upcomingUntil: new Date(
      now + days("HOUSECALL_ACTIVE_LOOKAHEAD_DAYS", 90) * 86_400_000,
    ).toISOString(),
  };
}
