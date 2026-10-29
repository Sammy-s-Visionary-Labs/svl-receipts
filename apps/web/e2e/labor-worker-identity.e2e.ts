import { expect, test } from "@playwright/test";
import { allocateLaborHours } from "@svl/domain";
import type { LaborDashboardData } from "../lib/labor/contract";
import { fixtureCookie } from "./fixture-auth.mjs";

// Synthetic browser responses only. Domain/store tests verify the calculation;
// this verifies canonical identities remain visible and survive editing settings.
test("shows one confirmed worker and combined overtime while preserving original names and unrelated draft rates", async ({
  page,
}) => {
  await page.clock.install();
  await page.context().addCookies([fixtureCookie("manager")]);
  const sourceName = "TEST short name";
  const canonicalName = "TEST Canonical Worker";
  const otherName = "TEST Other Worker";
  const workerAliases = [{ alias: sourceName, workerName: canonicalName }];
  const rules = {
    locations: [],
    jobAliases: [],
    workerAliases: [{ alias: "TEST nickname", workerName: sourceName }],
  };
  const overtime = { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 };
  let merged = false;
  let revision = 1;
  const writes: Record<string, unknown>[] = [];
  const blockedMutations: string[] = [];
  const entries: LaborDashboardData["entries"] = Array.from({ length: 6 }, (_, index) => ({
    id: `TEST-SOURCE-${index}`,
    kind: "work",
    date: `2026-10-${22 + index}`,
    workerName: index < 3 ? sourceName : canonicalName,
    jobName: "TEST Job",
    jobAddress: "TEST Address",
    jobKey: "TEST-SOURCE-JOB",
    clockIn: "08:00",
    clockOut: "16:00",
    clockInMethod: "Manual",
    clockOutMethod: "Manual",
    timeEntryType: "Work",
    crew: "TEST",
    role: "TEST",
    jobCode: null,
    employeeId: null,
    hours: 8,
    travel: false,
    laborCostCents: 0,
    billableCostCents: 0,
    sourceRow: index + 2,
    importId: "TEST-IMPORT",
  }));
  const rawNames = entries.map((entry) => entry.workerName);
  let canonicalRates = [
    { workerName: canonicalName, hourlyRateCents: 2500, active: true },
    { workerName: otherName, hourlyRateCents: 2000, active: true },
  ];
  const data = (): LaborDashboardData => ({
    dataRevision: `TEST-IDENTITY-${revision}`,
    development: false,
    allocation: allocateLaborHours({ entries, rules, ...(merged ? { workerAliases } : {}) }),
    jobMappings: [],
    jobMappingsRevision: 0,
    mappingSources: [],
    jobMappingSuggestions: [],
    jobCatalog: {
      jobs: [],
      complete: true,
      lastSuccessfulSyncAt: null,
      fingerprint: "TEST-CATALOG",
    },
    rules,
    rulesRevision: 0,
    paySettings: {
      overtime,
      workerRates: merged
        ? canonicalRates
        : [
            { workerName: sourceName, hourlyRateCents: 2500, active: true },
            { workerName: canonicalName, hourlyRateCents: null, active: true },
            { workerName: otherName, hourlyRateCents: 2000, active: true },
          ],
      ...(merged ? { workerAliases } : {}),
    },
    payRevision: revision,
    payroll: {
      workerWeeks: merged
        ? [
            {
              workerName: canonicalName,
              weekStart: "2026-10-22",
              weekEnd: "2026-10-28",
              grossHours: 48,
              lunchAdjustmentHours: -3,
              paidHours: 45,
              regularHours: 40,
              overtimeHours: 5,
              hourlyRateCents: 2500,
              regularPayCents: 100000,
              overtimePayCents: 18750,
              estimatedPayCents: 118750,
              active: true,
              complete: true,
            },
          ]
        : [],
      totals: {
        paidHours: merged ? 45 : 0,
        regularHours: merged ? 40 : 0,
        overtimeHours: merged ? 5 : 0,
        knownEstimatedPayCents: merged ? 118750 : 0,
        unpricedHours: 0,
      },
      warnings: [],
    },
    notes: [sourceName, canonicalName, "TEST nickname", otherName].map((workerName, index) => ({
      id: `TEST-NOTE-${index}`,
      importId: "TEST-NOTES-IMPORT",
      kind: "daily_candidate",
      date: "2026-10-22",
      rawDate: "2026-10-22",
      workerName,
      text: `TEST original comment ${index}`,
      notetaker: "TEST",
      project: "TEST",
      punchInfo: "",
      punchDuration: "",
      sourceRow: index + 2,
    })),
    notesImports: [],
    notesCoverage: [],
    sourceJobs: [],
    entries,
    imports: [],
    jobs: [],
    workers: [],
    overview: {
      hours: 48,
      travelHours: 0,
      workerCount: merged ? 1 : 2,
      jobCount: 1,
      entryCount: 6,
      reportedCostCents: 0,
    },
    sync: {
      enabled: false,
      hour: 6,
      timeZone: "America/New_York",
      lookbackDays: 14,
      intervalDays: 7,
      status: "idle",
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      workerHeartbeatAt: null,
      command: null,
      commandId: null,
    },
  });
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") blockedMutations.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/manager/labor", (route) => route.fulfill({ json: data() }));
  await page.route("**/api/manager/labor/status", (route) =>
    route.fulfill({
      json: { sync: data().sync, dataRevision: data().dataRevision, pendingDownload: null },
    }),
  );
  await page.route("**/api/manager/labor/pay", (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(body.expectedRevision).toBe(2);
    expect(body.settings.workerAliases).toEqual(workerAliases);
    canonicalRates = body.settings.workerRates;
    revision++;
    return route.fulfill({ json: { settings: body.settings, payRevision: revision } });
  });
  await page.goto("/labor-hours");
  const panel = page.getByRole("region", { name: "Weekly pay estimates", exact: true });
  await panel.getByText("Edit worker rates and overtime", { exact: true }).click();
  await expect(
    panel.getByLabel(`Hourly rate in dollars for ${sourceName}`, { exact: true }),
  ).toHaveValue("25.00");
  await panel.getByLabel(`Hourly rate in dollars for ${otherName}`, { exact: true }).fill("21.00");
  merged = true;
  revision = 2;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    panel.getByLabel(`Hourly rate in dollars for ${sourceName}`, { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByLabel(`Hourly rate in dollars for ${canonicalName}`, { exact: true }),
  ).toHaveCount(1);
  await expect(
    panel.getByLabel(`Hourly rate in dollars for ${otherName}`, { exact: true }),
  ).toHaveValue("21.00");
  await expect(panel).toContainText(
    `Also recorded as ${sourceName}. Combined for pay and weekly overtime.`,
  );
  const weekTable = panel
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Worker / week", exact: true }) });
  await expect(weekTable.getByRole("row")).toHaveCount(2);
  await expect(weekTable.getByRole("cell", { name: "5.00", exact: true })).toHaveCount(1);
  await expect(weekTable).toContainText("$1,187.50");
  await expect(
    panel.getByRole("button", { name: "Save pay settings", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Use latest saved settings", exact: true }).click();
  await expect(
    panel.getByLabel(`Hourly rate in dollars for ${canonicalName}`, { exact: true }),
  ).toHaveValue("25.00");
  await panel.getByLabel(`Hourly rate in dollars for ${otherName}`, { exact: true }).fill("21.00");
  await panel.getByRole("button", { name: "Save pay settings", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Pay settings saved");
  expect(writes).toHaveLength(1);
  expect((writes[0].settings as { workerRates: unknown[] }).workerRates).toEqual([
    { workerName: canonicalName, hourlyRateCents: 2500, active: true },
    { workerName: otherName, hourlyRateCents: 2100, active: true },
  ]);
  expect(entries.map((entry) => entry.workerName)).toEqual(rawNames);
  expect(blockedMutations).toEqual([]);

  const allocation = page.getByRole("region", { name: "Labor allocation", exact: true });
  await allocation
    .getByRole("combobox", { name: "Allocation worker", exact: true })
    .selectOption(canonicalName);
  await allocation.getByRole("button", { name: "Entry decisions", exact: true }).click();
  await expect(allocation.getByRole("table").getByRole("row")).toHaveCount(7);
  await expect(allocation.getByRole("table")).toContainText(sourceName);
  await expect(allocation.getByRole("table")).toContainText(canonicalName);
  await allocation.getByRole("button", { name: "Daily comments", exact: true }).click();
  await expect(allocation.getByRole("article")).toHaveCount(3);
  await expect(allocation).toContainText("TEST original comment 0");
  await expect(allocation).toContainText("TEST original comment 1");
  await expect(allocation).toContainText("TEST original comment 2");
  await expect(allocation).not.toContainText("TEST original comment 3");
  await expect(allocation).toContainText(sourceName);
  await expect(allocation).toContainText("TEST nickname");
  expect(blockedMutations).toEqual([]);
});
