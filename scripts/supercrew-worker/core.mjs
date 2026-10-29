import { resolve } from "node:path";

export const REPORT_URL = "https://app.supercrew.com/reports";
export const REPORT_DOWNLOAD_ORIGIN =
  "https://construction-userdata-production-036207347308-ca-central-1.s3.ca-central-1.amazonaws.com";
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

export function localAppUrl(value = "http://127.0.0.1:3145") {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("LABOR_APP_URL must be a local HTTP origin, such as http://127.0.0.1:3145.");
  }
  return url.origin;
}

export function workerAppUrl(value, allowedHost) {
  const url = new URL(value ?? "http://127.0.0.1:3145");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return localAppUrl(value);
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    allowedHost !== url.hostname ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Hosted LABOR_APP_URL requires HTTPS and an exact LABOR_APP_HOST allowlist match.",
    );
  }
  return url.origin;
}

export function workerConfig(env = process.env, cwd = process.cwd()) {
  const token = env.LABOR_WORKER_TOKEN;
  if (!token || token.length < 32) {
    throw new Error(
      "Set LABOR_WORKER_TOKEN to the receipt app's private worker token (at least 32 characters).",
    );
  }
  return {
    appUrl: workerAppUrl(env.LABOR_APP_URL, env.LABOR_APP_HOST),
    token,
    reportDownloadsApproved: env.SUPERCREW_REPORT_DOWNLOADS_APPROVED === "1",
    stateDir: resolve(cwd, ".local/labor-worker"),
    profileDir: resolve(cwd, ".local/labor-worker/profile"),
    reportDir: resolve(cwd, ".local/labor-worker/reports"),
    sessionEncryptionKey: env.LABOR_SESSION_ENCRYPTION_KEY,
  };
}

export function calendarDate(now, timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

export function addCalendarDays(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid calendar date.");
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid calendar date.");
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function reportInterval(now, lookbackDays = 14, timeZone = "America/New_York") {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) {
    throw new Error("The report lookback must be between 1 and 31 days.");
  }
  const today = calendarDate(now, timeZone).date;
  return {
    start: addCalendarDays(today, -lookbackDays),
    end: addCalendarDays(today, -1),
  };
}

export function shouldRunScheduled(sync, now, state = {}) {
  if (!state.connectedAt) return false;
  const next = nextScheduledRun(sync, now, state);
  return next !== null && Date.parse(next) <= now.getTime();
}

export function nextScheduledRun(sync, now = new Date(), state = {}) {
  if (!sync?.enabled || !["idle", "failed"].includes(sync.status)) return null;
  const timeZone = sync.timeZone ?? "America/New_York";
  const hour = sync.hour ?? 6;
  const intervalDays = sync.intervalDays ?? 1;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("The schedule hour must be from 0 to 23.");
  }
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) {
    throw new Error("The download interval must be from 1 to 365 days.");
  }
  const anchors = [];
  if (state.lastScheduledDate) {
    // Validate retained state before using it to suppress another source export.
    anchors.push(addCalendarDays(state.lastScheduledDate, 0));
  }
  if (sync.lastSuccessAt) {
    anchors.push(calendarDate(new Date(sync.lastSuccessAt), timeZone).date);
  }
  // Attempts consume the configured interval even when a download fails. A
  // later manual success resets that interval. Keep an overdue timestamp so
  // the displayed next run agrees with the worker's immediate catch-up.
  const latest = anchors.sort().at(-1);
  const date = latest ? addCalendarDays(latest, intervalDays) : calendarDate(now, timeZone).date;
  const anchor = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let skippedHourFallback = null;
  // Search civil times rather than apply a fixed UTC offset. Quarter-hour steps
  // support normal IANA offsets; the first occurrence owns a repeated fall hour.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = new Date(anchor + offset * 60000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    const candidateDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (candidateDate !== date || Number(parts.minute) !== 0) continue;
    if (Number(parts.hour) === hour) return candidate.toISOString();
    // A nonexistent spring hour runs at the first real full hour afterward.
    if (Number(parts.hour) > hour && !skippedHourFallback)
      skippedHourFallback = candidate.toISOString();
  }
  if (skippedHourFallback) return skippedHourFallback;
  throw new Error("Could not determine the next local schedule time.");
}

export function reportDateLabel(interval) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const format = (date) => formatter.format(new Date(`${date}T12:00:00Z`));
  return interval.start === interval.end
    ? format(interval.start)
    : `${format(interval.start)} - ${format(interval.end)}`;
}

export function monthLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function monthIndex(label) {
  const parsed = new Date(`${label} 1 UTC`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Unrecognized report calendar month.");
  return parsed.getUTCFullYear() * 12 + parsed.getUTCMonth();
}

export function validateWorkbookBytes(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_REPORT_BYTES) {
    throw new Error("The downloaded report is empty or exceeds the 10 MB limit.");
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error(
      "The source returned something other than an XLSX workbook. Reconnect if login expired.",
    );
  }
  return bytes;
}

export function isApprovedReportResponse(response) {
  const url = new URL(response.url());
  if (
    url.origin !== REPORT_DOWNLOAD_ORIGIN ||
    response.status() < 200 ||
    response.status() >= 300
  ) {
    return false;
  }
  const headers = response.headers();
  const mime = headers["content-type"]?.split(";")[0].trim().toLowerCase();
  const disposition = headers["content-disposition"] ?? "";
  return (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /filename[^;]*\.xlsx/i.test(disposition) ||
    /\.xlsx$/i.test(url.pathname)
  );
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Browser errors may contain signed download URLs. Never persist those secrets
  // in application heartbeat messages or routine terminal logs.
  return message.replace(/https?:\/\/[^\s"'<>]+/g, "[URL redacted]").slice(0, 500);
}
