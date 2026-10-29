import { expect, type Page, test } from "@playwright/test";
import { allocateLaborHours, estimateLaborPay } from "@svl/domain";
import type { LaborDashboardData, LaborSyncState } from "../lib/labor/contract";
import { fixtureCookie } from "./fixture-auth.mjs";

function emptyDashboard(sync: LaborSyncState): LaborDashboardData {
  const rules = { locations: [], jobAliases: [], workerAliases: [] };
  const paySettings = {
    workerRates: [],
    overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
  };
  return {
    dataRevision: "TEST-EMPTY-SOURCE-REVISION",
    development: false,
    allocation: allocateLaborHours({ entries: [], rules }),
    jobMappings: [],
    jobMappingsRevision: 0,
    mappingSources: [],
    jobCatalog: {
      jobs: [],
      complete: true,
      lastSuccessfulSyncAt: null,
      fingerprint: "TEST-CATALOG",
    },
    jobMappingSuggestions: [],
    rules,
    rulesRevision: 0,
    paySettings,
    payRevision: 0,
    payroll: estimateLaborPay({ workerDays: [], settings: paySettings }),
    notes: [],
    notesImports: [],
    notesCoverage: [],
    sourceJobs: [],
    entries: [],
    imports: [],
    jobs: [],
    workers: [],
    overview: {
      hours: 0,
      travelHours: 0,
      workerCount: 0,
      jobCount: 0,
      entryCount: 0,
      reportedCostCents: 0,
    },
    sync,
  };
}

async function scheduleFixture(
  page: Page,
  pendingDownload: LaborDashboardData["pendingDownload"] = null,
) {
  await page.clock.install();
  await page.context().addCookies([fixtureCookie("manager")]);
  let sync: LaborSyncState = {
    enabled: false,
    hour: 6,
    timeZone: "America/New_York",
    lookbackDays: 14,
    intervalDays: 1,
    status: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    lastError: null,
    workerHeartbeatAt: null,
    command: null,
    commandId: null,
  };
  const dashboard = emptyDashboard(sync);
  const writes: Record<string, unknown>[] = [];
  const blockedMutations: string[] = [];
  let statusReads = 0;
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") blockedMutations.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/manager/labor", (route) =>
    route.fulfill({ json: { ...dashboard, sync, pendingDownload } }),
  );
  await page.route("**/api/manager/labor/status", (route) => {
    statusReads++;
    return route.fulfill({ json: { sync, pendingDownload, dataRevision: dashboard.dataRevision } });
  });
  await page.route("**/api/manager/labor/sync", (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(["configure", "resume", "pause"]).toContain(body.action);
    if (body.action === "pause") sync = { ...sync, enabled: false, nextRunAt: null };
    else {
      sync = {
        ...sync,
        hour: body.hour,
        lookbackDays: body.lookbackDays,
        intervalDays: body.intervalDays,
        enabled: body.action === "resume" ? true : sync.enabled,
      };
    }
    return route.fulfill({ json: { sync } });
  });
  await page.goto("/labor-hours");
  const panel = page.getByRole("region", { name: "Recurring Supercrew downloads", exact: true });
  await expect(panel.getByLabel("Download frequency")).toHaveValue("1");
  return { panel, writes, blockedMutations, statusReads: () => statusReads };
}

test("saves weekly, biweekly and custom schedules without enabling paused downloads", async ({
  page,
}) => {
  const state = await scheduleFixture(page);
  const frequency = state.panel.getByLabel("Download frequency");
  for (const [value, label] of [
    ["7", "Weekly"],
    ["14", "Every two weeks"],
    ["custom", "Every 45 days"],
  ]) {
    await frequency.selectOption(value);
    if (value === "custom") await state.panel.getByLabel("Repeat every (days)").fill("45");
    await state.panel.getByRole("button", { name: "Save schedule", exact: true }).click();
    await expect(state.panel).toContainText(`${label} schedule paused`);
    await expect(
      page.getByRole("status").filter({ hasText: "Downloads remain paused" }),
    ).toBeVisible();
    await expect(
      state.panel.getByRole("button", { name: "Enable recurring downloads", exact: true }),
    ).toBeVisible();
  }
  expect(state.writes).toEqual(
    [7, 14, 45].map((intervalDays) => ({
      action: "configure",
      hour: 6,
      lookbackDays: 14,
      intervalDays,
    })),
  );
  await state.panel
    .getByRole("button", { name: "Enable recurring downloads", exact: true })
    .click();
  await expect(state.panel).toContainText("Every 45 days schedule enabled");
  expect(state.writes.at(-1)).toEqual({
    action: "resume",
    hour: 6,
    lookbackDays: 14,
    intervalDays: 45,
  });
  await state.panel.getByRole("button", { name: "Pause downloads", exact: true }).click();
  await expect(state.panel).toContainText("Every 45 days schedule paused");
  expect(state.writes.at(-1)).toEqual({ action: "pause" });
  expect(state.blockedMutations).toEqual([]);
});

test("rejects out-of-range custom intervals in the browser before submitting", async ({ page }) => {
  const state = await scheduleFixture(page);
  await state.panel.getByLabel("Download frequency").selectOption("custom");
  const input = state.panel.getByLabel("Repeat every (days)");
  for (const value of ["0", "366", "1.5", ""]) {
    await input.fill(value);
    await state.panel.getByRole("button", { name: "Save schedule", exact: true }).click();
    expect(await input.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
    await expect(input).toBeFocused();
    expect(state.writes).toEqual([]);
  }
  await input.fill("365");
  await state.panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(state.panel).toContainText("Every 365 days schedule paused");
  expect(state.writes[0]?.intervalDays).toBe(365);
  expect(state.blockedMutations).toEqual([]);
});

test("status polling preserves unsaved frequency edits and shows paused catch-up dates", async ({
  page,
}, testInfo) => {
  const state = await scheduleFixture(page, {
    from: "2026-09-02",
    to: "2026-10-28",
    nextRunAt: null,
  });
  const frequency = state.panel.getByLabel("Download frequency");
  await frequency.selectOption("custom");
  await state.panel.getByLabel("Repeat every (days)").fill("23");
  await state.panel.getByLabel("Start time", { exact: true }).selectOption("9");
  await state.panel.getByLabel("Days to download").fill("7");
  await page.clock.runFor(60_000);
  await expect.poll(state.statusReads).toBeGreaterThanOrEqual(2);
  await expect(frequency).toHaveValue("custom");
  await expect(state.panel.getByLabel("Repeat every (days)")).toHaveValue("23");
  await expect(state.panel.getByLabel("Start time", { exact: true })).toHaveValue("9");
  await expect(state.panel.getByLabel("Days to download")).toHaveValue("7");
  await expect(state.panel).toContainText("Daily schedule paused");
  await expect(state.panel).toContainText("Dates remaining:");
  await expect(state.panel).toContainText(
    "Enable recurring downloads or queue another download to continue.",
  );
  expect(state.writes).toEqual([]);
  expect(state.blockedMutations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await state.panel.screenshot({ path: testInfo.outputPath("recurrence-catchup-narrow.png") });
});

test("shows a persisted download as queued, then running and completed without another request", async ({
  page,
}) => {
  await page.clock.install();
  await page.context().addCookies([fixtureCookie("manager")]);
  let sync: LaborSyncState = {
    enabled: false,
    hour: 6,
    timeZone: "America/New_York",
    lookbackDays: 14,
    status: "idle",
    lastAttemptAt: "2026-10-01T14:00:00.000Z",
    lastSuccessAt: "2026-10-01T14:01:00.000Z",
    nextRunAt: null,
    lastError: null,
    workerHeartbeatAt: "2026-10-01T14:01:00.000Z",
    command: "run",
    commandId: "a2700000-0000-4000-8000-000000000099",
  };
  const dashboard = emptyDashboard(sync);
  const mutations: string[] = [];
  let statusReads = 0;
  // Browser responses only. Unknown API requests are blocked, including every
  // queue/import/approval/send operation. No application mutation route runs.
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") mutations.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/manager/labor", (route) =>
    route.fulfill({ json: { ...dashboard, sync } }),
  );
  await page.route("**/api/manager/labor/status", (route) => {
    statusReads++;
    return route.fulfill({ json: { sync, dataRevision: dashboard.dataRevision } });
  });
  await page.goto("/labor-hours");
  const panel = page.getByRole("region", { name: "Recurring Supercrew downloads", exact: true });
  await expect(panel.getByRole("button", { name: "Download queued", exact: true })).toBeDisabled();
  await expect(panel.getByText("Download queued", { exact: true })).toHaveCount(2);
  await expect(panel).toContainText("No worker has claimed it yet");
  await expect(panel.getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(panel).not.toContainText("offline");

  await page.reload();
  await expect(panel.getByRole("button", { name: "Download queued", exact: true })).toBeDisabled();

  sync = { ...sync, status: "running", workerHeartbeatAt: "2026-10-23T15:44:00.000Z" };
  await page.clock.runFor(30_000);
  await expect(panel.getByRole("button", { name: "Downloading…", exact: true })).toBeDisabled();
  await expect(panel.getByText("Downloading reports", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("No worker has claimed it yet");

  sync = {
    ...sync,
    status: "idle",
    command: null,
    commandId: null,
    lastSuccessAt: "2026-10-23T15:45:00.000Z",
    workerHeartbeatAt: "2026-10-23T15:45:00.000Z",
  };
  await page.clock.runFor(30_000);
  await expect(panel.getByRole("button", { name: "Queue download", exact: true })).toBeEnabled();
  await expect(panel.getByText("Ready", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("No worker has claimed it yet");
  await expect(
    panel.locator("dl > div").filter({ hasText: "Last successful import" }),
  ).toContainText("Oct 23, 11:45 AM EDT");
  expect(statusReads).toBeGreaterThanOrEqual(2);
  expect(mutations).toEqual([]);
});
