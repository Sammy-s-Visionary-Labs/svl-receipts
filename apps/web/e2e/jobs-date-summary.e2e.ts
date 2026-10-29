import { expect, type Page, test } from "@playwright/test";
import type { LaborEntryAllocation } from "@svl/domain";
import type { JobActivity, JobReceiptActivity, JobsDashboardData } from "../lib/labor/contract";
import { fixtureCookie } from "./fixture-auth.mjs";

const receipt = (id: string, submittedAt: string): JobReceiptActivity => ({
  id,
  reference: id,
  vendor: `TEST ${id}`,
  submittedAt,
  status: "needs_review",
  amountCents: 1000,
  href: null,
  developmentFixture: true,
});

// These timestamps straddle New York midnight, despite sharing one UTC date.
const firstReceipt = receipt("ASSIGNED-OCT-1", "2026-10-02T03:59:59.000Z");
const secondReceipt = receipt("ASSIGNED-OCT-2", "2026-10-02T04:00:00.000Z");
const receiptOnly = receipt("RECEIPT-ONLY-OCT-1", "2026-10-01T16:00:00.000Z");
const makeJob = (key: string, name: string, receipts: JobReceiptActivity[]): JobActivity => ({
  key,
  name,
  address: `TEST ${key} Address`,
  housecallJobId: null,
  hours: 0,
  travelHours: 0,
  reportedCostCents: null,
  entryCount: 0,
  workerCount: 0,
  receiptCount: receipts.length,
  receiptTotalCents: receipts.reduce((sum, item) => sum + (item.amountCents ?? 0), 0),
  receipts,
  allocationStatus: "allocated",
});
const alpha = makeJob("TEST-ALPHA", "TEST Alpha", [firstReceipt, secondReceipt]);
const beta = makeJob("TEST-BETA", "TEST Beta", []);
const gamma = makeJob("TEST-GAMMA", "TEST Gamma receipts only", [receiptOnly]);
const sources = [
  { id: "TEST-ROW-1", date: "2026-10-01", workerName: "TEST Worker A", hours: 1.25, job: alpha },
  { id: "TEST-ROW-2", date: "2026-10-02", workerName: "TEST Worker B", hours: 2.5, job: alpha },
  { id: "TEST-ROW-3", date: "2026-10-03", workerName: "TEST Worker A", hours: 3.75, job: beta },
];
const allocations: LaborEntryAllocation[] = sources.map((source, index) => ({
  sourceEntryId: source.id,
  sourceRow: index + 2,
  date: source.date,
  workerName: source.workerName,
  sourceJobKey: source.job.key,
  destinationSourceKey: source.job.key,
  sourceKind: "work",
  sourceHours: source.hours,
  status: "allocated",
  job: {
    key: source.job.key,
    name: source.job.name,
    address: source.job.address,
    housecallJobId: null,
  },
  allocatedHours: source.hours,
  excludedHours: 0,
  pendingHours: 0,
  reason: "reviewed_customer",
  reviewReasons: [],
  noteIds: [],
}));
const dashboard: JobsDashboardData = {
  development: true,
  allocation: {
    rulesVersion: "TEST-DATE-SUMMARY",
    entries: allocations,
    workerDays: sources.map((source) => ({
      key: source.id,
      date: source.date,
      workerName: source.workerName,
      grossHours: source.hours,
      sourceBreakHours: 0,
      sourceNetHours: source.hours,
      lunchAdjustmentHours: 0,
      breakDifferenceHours: 0,
      netHours: source.hours,
      allocatedHours: source.hours,
      excludedHours: 0,
      pendingHours: 0,
      reviewReasons: [],
    })),
    jobs: [],
    totals: {
      grossHours: 7.5,
      sourceBreakHours: 0,
      sourceNetHours: 7.5,
      lunchAdjustmentHours: 0,
      netHours: 7.5,
      allocatedHours: 7.5,
      excludedHours: 0,
      pendingHours: 0,
    },
    warnings: [],
  },
  imports: [],
  jobs: [alpha, beta, gamma].map((job) => {
    const rows = sources.filter((source) => source.job.key === job.key);
    return {
      ...job,
      hours: rows.reduce((sum, row) => sum + row.hours, 0),
      entryCount: rows.length,
      workerCount: new Set(rows.map((row) => row.workerName)).size,
    };
  }),
  entries: sources.map((source, index) => ({
    id: source.id,
    workerName: source.workerName,
    date: source.date,
    kind: "work",
    hours: source.hours,
    jobName: source.job.name,
    jobAddress: source.job.address,
    clockIn: "08:00",
    clockOut: ["09:15", "10:30", "11:45"][index],
    clockInMethod: "Manual",
    clockOutMethod: "Manual",
    timeEntryType: "Work",
    crew: "TEST",
    role: "TEST",
    jobCode: null,
    employeeId: null,
    travel: false,
    laborCostCents: 0,
    billableCostCents: 0,
    sourceRow: index + 2,
    importId: "TEST-IMPORT",
    jobKey: source.job.key,
  })),
  unassignedReceipts: [
    receipt("UNASSIGNED-OCT-1", "2026-10-02T03:59:59.000Z"),
    receipt("UNASSIGNED-OCT-2", "2026-10-02T04:00:00.000Z"),
  ],
  receiptSource: "local_development",
  warnings: [],
};

async function expectSummary(
  page: Page,
  jobs: number,
  allocatedHours: string,
  assignedReceipts: number,
  unassignedReceipts: number,
) {
  const expected = [
    ["Jobs with activity", String(jobs)],
    ["Allocated job hours", allocatedHours],
    ["Assigned receipts", String(assignedReceipts)],
    ["Unassigned receipts", String(unassignedReceipts)],
  ];
  for (const [label, value] of expected) {
    await expect(page.getByText(label, { exact: true }).locator("..").locator("strong")).toHaveText(
      value,
    );
  }
}

test("Jobs date filters update all four summaries and activity groups, including NY-dated receipts and empty ranges", async ({
  page,
}) => {
  await page.context().addCookies([fixtureCookie("manager")]);
  const mutations: string[] = [];
  // Only this synthetic GET can resolve. No real data, approval or provider
  // mutation route is reached by the test, even if the UI regresses.
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/manager/jobs/activity"
    )
      return route.fulfill({ json: dashboard });
    if (request.method() !== "GET") mutations.push(request.url());
    return route.abort();
  });
  await page.goto(`/jobs?job=${alpha.key}`);
  await expectSummary(page, 3, "7.50", 3, 2);

  const from = page.getByLabel("From", { exact: true });
  const through = page.getByLabel("Through", { exact: true });
  const groups = page.getByRole("region", { name: "Jobs and their activity", exact: true });
  const unassigned = page.getByRole("region", { name: "Unassigned receipts", exact: true });
  await from.fill("2026-10-01");
  await through.fill("2026-10-01");
  await expectSummary(page, 2, "1.25", 2, 1);
  await expect(groups.getByRole("button", { name: /^TEST Alpha/ })).toContainText(
    "1.25 h · 1 workers · 1 receipts",
  );
  await expect(groups.getByRole("button", { name: /^TEST Gamma/ })).toBeVisible();
  await expect(groups.getByRole("button", { name: /^TEST Beta/ })).toHaveCount(0);
  await expect(unassigned).toContainText("UNASSIGNED-OCT-1");
  await expect(unassigned).not.toContainText("UNASSIGNED-OCT-2");

  await through.fill("2026-10-02");
  await from.fill("2026-10-02");
  await expectSummary(page, 1, "2.50", 1, 1);
  await expect(groups.getByRole("button", { name: /^TEST Alpha/ })).toContainText(
    "2.50 h · 1 workers · 1 receipts",
  );
  await expect(groups.getByRole("button", { name: /^TEST Gamma/ })).toHaveCount(0);
  await expect(unassigned).not.toContainText("UNASSIGNED-OCT-1");
  await expect(unassigned).toContainText("UNASSIGNED-OCT-2");

  await through.fill("2026-10-03");
  await from.fill("2026-10-03");
  await expectSummary(page, 1, "3.75", 0, 0);
  await expect(groups.getByRole("button", { name: /^TEST Beta/ })).toContainText(
    "3.75 h · 1 workers · 0 receipts",
  );
  // Filtering activity must not silently change the selected approval identity.
  await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${alpha.key}$`));
  await expect(groups.getByRole("heading", { name: alpha.name, exact: true })).toBeVisible();

  await through.fill("2026-10-04");
  await from.fill("2026-10-04");
  await expectSummary(page, 0, "0.00", 0, 0);
  await expect(groups.getByRole("button")).toHaveCount(0);
  await expect(groups).toContainText("No jobs with activity in these filters.");
  await expect(unassigned).toContainText("No unassigned receipts");

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expectSummary(page, 3, "7.50", 3, 2);
  await expect(from).toHaveValue("");
  await expect(through).toHaveValue("");
  await page
    .getByRole("combobox", { name: "Worker hours", exact: true })
    .selectOption("TEST Worker B");
  await expectSummary(page, 2, "2.50", 3, 2);
  await expect(groups.getByRole("button", { name: /^TEST Beta/ })).toHaveCount(0);
  await page.getByLabel("Find a job", { exact: true }).fill("TEST Beta");
  await expect(groups).toContainText("No jobs with activity in these filters.");
  await expectSummary(page, 2, "2.50", 3, 2);
  expect(mutations).toEqual([]);
});
