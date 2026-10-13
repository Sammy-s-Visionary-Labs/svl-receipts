import assert from "node:assert/strict";
import test from "node:test";
import {
  addCalendarDays,
  calendarDate,
  isApprovedReportResponse,
  localAppUrl,
  MAX_REPORT_BYTES,
  monthIndex,
  nextScheduledRun,
  REPORT_DOWNLOAD_ORIGIN,
  reportDateLabel,
  reportInterval,
  safeError,
  shouldRunScheduled,
  validateWorkbookBytes,
  workerConfig,
} from "./core.mjs";
import {
  acquirePairedReports,
  appRequest,
  idleWorkerHeartbeat,
  uploadPairedWorkbooks,
  uploadWorkbook,
} from "./worker.mjs";

test("development ingestion can only target a local HTTP origin", () => {
  assert.equal(localAppUrl(), "http://127.0.0.1:3145");
  assert.equal(localAppUrl("http://localhost:3145/"), "http://localhost:3145");
  assert.equal(localAppUrl("http://[::1]:3145"), "http://[::1]:3145");
  for (const value of [
    "https://svl-receipts-web.vercel.app",
    "http://127.0.0.1.evil.example",
    "http://user:pass@localhost",
    "http://localhost/api",
    "http://localhost?token=secret",
    "http://localhost#anything",
    "file:///tmp/server",
  ]) {
    assert.throws(() => localAppUrl(value));
  }
});

test("worker secrets and report transfer opt-in are required explicitly", () => {
  assert.throws(() => workerConfig({}), /token/i);
  assert.throws(() => workerConfig({ LABOR_WORKER_TOKEN: "a".repeat(31) }), /32/);
  assert.equal(workerConfig({ LABOR_WORKER_TOKEN: "a".repeat(32) }).token.length, 32);
  const config = workerConfig(
    {
      LABOR_WORKER_TOKEN: "development-test-token-123456789012",
      SUPERCREW_REPORT_DOWNLOADS_APPROVED: "true",
    },
    "/tmp/test-project",
  );
  assert.equal(config.reportDownloadsApproved, false);
  assert.equal(config.profileDir, "/tmp/test-project/.local/labor-worker/profile");
  assert.equal(
    workerConfig({ LABOR_WORKER_TOKEN: config.token, SUPERCREW_REPORT_DOWNLOADS_APPROVED: "1" })
      .reportDownloadsApproved,
    true,
  );
});

test("reports cover completed local dates across both DST transitions", () => {
  assert.deepEqual(reportInterval(new Date("2026-03-08T10:00:00Z")), {
    start: "2026-02-22",
    end: "2026-03-07",
  });
  assert.deepEqual(reportInterval(new Date("2026-11-01T11:00:00Z")), {
    start: "2026-10-18",
    end: "2026-10-31",
  });
  assert.deepEqual(reportInterval(new Date("2026-09-29T02:00:00Z")), {
    start: "2026-09-14",
    end: "2026-09-27",
  });
  assert.deepEqual(calendarDate(new Date("2026-09-29T10:00:00Z")), { date: "2026-09-29", hour: 6 });
  assert.equal(addCalendarDays("2026-01-01", -1), "2025-12-31");
  assert.throws(() => addCalendarDays("2026-02-30", 1));
  assert.throws(() => reportInterval(new Date(), 0));
  assert.throws(() => reportInterval(new Date(), 32), /31/);
  assert.deepEqual(reportInterval(new Date("2026-09-29T10:00:00Z"), 31), {
    start: "2026-08-29",
    end: "2026-09-28",
  });
});

test("schedule catches up after local six and makes one attempt per day", () => {
  const sync = { enabled: true, hour: 6, timeZone: "America/New_York", status: "idle" };
  const state = { connectedAt: "2026-09-28T10:00:00Z" };
  assert.equal(shouldRunScheduled(sync, new Date("2026-09-29T09:59:00Z"), state), false);
  assert.equal(shouldRunScheduled(sync, new Date("2026-09-29T10:00:00Z"), state), true);
  assert.equal(shouldRunScheduled(sync, new Date("2026-09-29T18:00:00Z"), state), true);
  assert.equal(
    shouldRunScheduled(sync, new Date("2026-09-29T18:00:00Z"), {
      ...state,
      lastScheduledDate: "2026-09-29",
    }),
    false,
  );
  assert.equal(
    shouldRunScheduled({ ...sync, enabled: false }, new Date("2026-09-29T18:00:00Z"), state),
    false,
  );
  assert.equal(
    shouldRunScheduled(
      { ...sync, lastSuccessAt: "2026-09-29T10:15:00Z" },
      new Date("2026-09-29T18:00:00Z"),
      state,
    ),
    false,
  );
  assert.equal(shouldRunScheduled(sync, new Date("2026-11-01T11:00:00Z"), state), true);
});

test("unconnected or expired sessions do not auto-run or falsely become connected", () => {
  const now = new Date("2026-09-29T18:00:00Z");
  const sync = { enabled: true, hour: 6, timeZone: "America/New_York", status: "not_connected" };
  assert.equal(shouldRunScheduled(sync, now, {}), false);
  assert.equal(idleWorkerHeartbeat(sync, now, {}), null);
  const connected = { connectedAt: "2026-09-28T10:00:00Z" };
  assert.equal(shouldRunScheduled({ ...sync, status: "idle" }, now, {}), false);
  assert.equal(shouldRunScheduled({ ...sync, status: "needs_login" }, now, connected), false);
  assert.deepEqual(
    idleWorkerHeartbeat(
      { ...sync, status: "needs_login", lastError: "Sign in again" },
      now,
      connected,
    ),
    {
      status: "needs_login",
      lastError: "Sign in again",
      nextRunAt: null,
    },
  );
});

test("upcoming configured local schedule uses the correct DST offset and pauses cleanly", () => {
  const sync = { enabled: true, hour: 6, timeZone: "America/New_York", status: "idle" };
  assert.equal(
    nextScheduledRun(sync, new Date("2026-03-07T12:00:00Z")),
    "2026-03-08T10:00:00.000Z",
  );
  assert.equal(
    nextScheduledRun(sync, new Date("2026-10-31T12:00:00Z")),
    "2026-11-01T11:00:00.000Z",
  );
  assert.equal(
    nextScheduledRun({ ...sync, hour: 8 }, new Date("2026-09-29T10:00:00Z")),
    "2026-09-29T12:00:00.000Z",
  );
  assert.equal(nextScheduledRun({ ...sync, enabled: false }, new Date()), null);
  assert.equal(nextScheduledRun({ ...sync, status: "not_connected" }, new Date()), null);
  assert.equal(nextScheduledRun({ ...sync, status: "needs_login" }, new Date()), null);
  assert.equal(
    nextScheduledRun({ ...sync, hour: 2 }, new Date("2026-03-07T12:00:00Z")),
    "2026-03-08T07:00:00.000Z",
  );
});

test("report labels match observed Supercrew UI and calendar navigation spans years", () => {
  assert.equal(
    reportDateLabel({ start: "2026-09-15", end: "2026-09-28" }),
    "Sep 15, 2026 - Sep 28, 2026",
  );
  assert.equal(reportDateLabel({ start: "2026-09-28", end: "2026-09-28" }), "Sep 28, 2026");
  assert.equal(monthIndex("January 2027") - monthIndex("December 2026"), 1);
});

test("download acceptance rejects login HTML, oversized reports, and other report origins", () => {
  assert.throws(
    () => validateWorkbookBytes(Buffer.from("<html>Sign in</html>")),
    /other than an XLSX/,
  );
  assert.throws(() => validateWorkbookBytes(Buffer.alloc(MAX_REPORT_BYTES + 1)), /limit/);
  assert.equal(validateWorkbookBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04])).length, 4);
  const response = (
    url,
    status = 200,
    type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ) => ({ url: () => url, status: () => status, headers: () => ({ "content-type": type }) });
  assert.equal(
    isApprovedReportResponse(response(`${REPORT_DOWNLOAD_ORIGIN}/report.xlsx?signature=private`)),
    true,
  );
  assert.equal(isApprovedReportResponse(response("https://evil.example/report.xlsx")), false);
  assert.equal(
    isApprovedReportResponse(response(`${REPORT_DOWNLOAD_ORIGIN}/report.xlsx`, 403)),
    false,
  );
  assert.equal(
    isApprovedReportResponse(response(`${REPORT_DOWNLOAD_ORIGIN}/login`, 200, "text/html")),
    false,
  );
});

test("private signed URLs never reach routine error messages", () => {
  const error = safeError(
    new Error("Download failed at https://private.example/file.xlsx?X-Amz-Signature=secret"),
  );
  assert.equal(error, "Download failed at [URL redacted]");
  assert.equal(error.includes("secret"), false);
  assert.equal(safeError(new Error("a".repeat(800))).length, 500);
});

test("source upload uses only the development endpoint and bearer token", async () => {
  const config = workerConfig({ LABOR_WORKER_TOKEN: "development-test-token-123456789012" });
  let request;
  const mockedFetch = async (url, init) => {
    request = { url, init };
    return { ok: true, json: async () => ({ duplicate: false }) };
  };
  const result = await uploadWorkbook(
    config,
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    { start: "2026-09-15", end: "2026-09-28" },
    mockedFetch,
  );
  assert.equal(result.duplicate, false);
  assert.equal(request.url, "http://127.0.0.1:3145/api/manager/labor/import");
  assert.equal(request.init.headers.get("Authorization"), `Bearer ${config.token}`);
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.body.get("source"), "supercrew");
  assert.equal(
    request.init.body.get("file").name,
    "Supercrew_Timesheet_2026-09-15_2026-09-28.xlsx",
  );
  await assert.rejects(
    appRequest(config, "/api/manager/labor/worker", {}, async () => ({ ok: false, status: 401 })),
    /HTTP 401/,
  );
});

test("local import errors expose a bounded actionable message without tokens or signed URLs", async () => {
  const config = workerConfig({ LABOR_WORKER_TOKEN: "development-test-token-123456789012" });
  const response = () =>
    Response.json(
      {
        error: {
          message: `All Entries row 459: unknown capture method at https://source.example/file.xlsx?secret=hidden token ${config.token}`,
        },
      },
      { status: 400 },
    );
  await assert.rejects(
    appRequest(config, "/api/manager/labor/import", {}, async () => response()),
    (error) => {
      assert.equal(error.message.includes("HTTP 400: All Entries row 459"), true);
      assert.equal(error.message.includes("[URL redacted]"), true);
      assert.equal(error.message.includes("[token redacted]"), true);
      assert.equal(error.message.includes(config.token), false);
      assert.equal(error.message.includes("secret=hidden"), false);
      assert.ok(error.message.length <= 500);
      return true;
    },
  );
  await assert.rejects(
    appRequest(config, "/api/manager/labor/import", {}, async () =>
      Response.json({ error: { message: "a".repeat(9000) } }, { status: 400 }),
    ),
    /Check the worker token/,
  );
  await assert.rejects(
    appRequest(
      config,
      "/api/manager/labor/import",
      {},
      async () => new Response("<html>server unavailable</html>", { status: 503 }),
    ),
    /HTTP 503.*Check the worker token/,
  );
});

test("paired upload sends both validated original reports for the same explicit daily-note period", async () => {
  const config = workerConfig({ LABOR_WORKER_TOKEN: "development-test-token-123456789012" });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const notesBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 17]);
  let request;
  let requests = 0;
  const mockFetch = async (url, init) => {
    requests++;
    request = { url, init };
    return { ok: true, json: async () => ({ duplicate: false }) };
  };
  await uploadPairedWorkbooks(
    config,
    bytes,
    notesBytes,
    { start: "2026-09-24", end: "2026-09-30" },
    mockFetch,
  );
  assert.equal(request.url, "http://127.0.0.1:3145/api/manager/labor/import");
  assert.equal(request.init.headers.get("Authorization"), `Bearer ${config.token}`);
  assert.equal(request.init.body.get("notesScope"), "daily_timesheet");
  assert.equal(request.init.body.get("periodStart"), "2026-09-24");
  assert.equal(request.init.body.get("periodEnd"), "2026-09-30");
  assert.deepEqual(Buffer.from(await request.init.body.get("file").arrayBuffer()), bytes);
  assert.deepEqual(Buffer.from(await request.init.body.get("notesFile").arrayBuffer()), notesBytes);
  assert.throws(
    () =>
      uploadPairedWorkbooks(
        config,
        bytes,
        Buffer.from("login HTML"),
        { start: "2026-09-24", end: "2026-09-30" },
        mockFetch,
      ),
    /other than an XLSX/,
  );
  assert.equal(requests, 1);
});

test("paired acquisition preserves Timesheet before Notes and refuses an unverified note scope", async () => {
  const config = { reportDir: "/tmp/test-private-reports", reportDownloadsApproved: true };
  const interval = { start: "2026-09-24", end: "2026-09-30" };
  const events = [];
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let scope = "daily_timesheet";
  const operations = {
    prepareReport: async (_page, actual) => {
      assert.equal(actual, interval);
      events.push("timesheet:prepare");
      return { download: "timesheet" };
    },
    prepareNotesReport: async (_page, actual) => {
      assert.equal(actual, interval);
      events.push("notes:prepare");
      return { download: "notes", scope };
    },
    downloadWorkbook: async (_page, _context, button, path, approved) => {
      assert.equal(approved, true);
      assert.equal(path.includes(`supercrew-${button}-2026-09-24-2026-09-30-`), true);
      events.push(`${button}:download`);
      return bytes;
    },
    writeFile: async (path, contents, options) => {
      assert.equal(contents, bytes);
      assert.equal(options.mode, 0o600);
      events.push(path.includes("timesheet") ? "timesheet:preserved" : "notes:preserved");
    },
  };
  assert.deepEqual(
    await acquirePairedReports(
      config,
      interval,
      new Date("2026-10-01T10:00:00Z"),
      {},
      {},
      operations,
    ),
    { bytes, notesBytes: bytes },
  );
  assert.deepEqual(events, [
    "timesheet:prepare",
    "timesheet:download",
    "timesheet:preserved",
    "notes:prepare",
    "notes:download",
    "notes:preserved",
  ]);
  events.length = 0;
  scope = "mixed";
  await assert.rejects(
    acquirePairedReports(config, interval, new Date(), {}, {}, operations),
    /Nothing was imported/,
  );
  assert.deepEqual(events, [
    "timesheet:prepare",
    "timesheet:download",
    "timesheet:preserved",
    "notes:prepare",
  ]);
});
