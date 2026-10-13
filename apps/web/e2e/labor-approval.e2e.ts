import { expect, type Page, test } from "@playwright/test";
import type { LaborEntryAllocation } from "@svl/domain";
import type {
  LaborApprovalHistoryItem,
  LaborApprovalPreview,
  LaborApprovalWorkspaceData,
} from "../lib/labor/approval-contract";
import type { JobActivity, JobsDashboardData } from "../lib/labor/contract";
import { fixtureCookie } from "./fixture-auth.mjs";

// Browser-only synthetic API responses: no approval, database or provider route is reached.
const job: JobActivity = {
  key: "housecall:TEST-HCP-JOB",
  name: "TEST Customer · #1001 · TEST Project",
  address: "TEST Address",
  housecallJobId: "TEST-HCP-JOB",
  hours: 6,
  travelHours: 0,
  reportedCostCents: null,
  entryCount: 3,
  workerCount: 2,
  receiptCount: 0,
  receiptTotalCents: null,
  receipts: [],
  allocationStatus: "mapped",
};
const sources = [
  { id: "TEST-WORKER-1", workerName: "TEST Worker", date: "2026-10-01" },
  { id: "TEST-WORKER-2", workerName: "TEST Worker", date: "2026-10-02" },
  { id: "TEST-OWNER-1", workerName: "TEST Owner", date: "2026-10-01" },
];
const decisions: LaborEntryAllocation[] = sources.map((source, index) => ({
  sourceEntryId: source.id,
  sourceRow: index + 2,
  date: source.date,
  workerName: source.workerName,
  sourceJobKey: "TEST-SOURCE",
  destinationSourceKey: "TEST-SOURCE",
  sourceKind: "work",
  sourceHours: 2,
  status: "allocated",
  job: { key: job.key, name: job.name, address: job.address, housecallJobId: job.housecallJobId },
  allocatedHours: 2,
  excludedHours: 0,
  pendingHours: 0,
  reason: "customer_work",
  reviewReasons: [],
  noteIds: [],
}));
const jobsData: JobsDashboardData = {
  development: true,
  allocation: {
    rulesVersion: "TEST",
    entries: decisions,
    workerDays: sources.map((source) => ({
      key: source.id,
      workerName: source.workerName,
      date: source.date,
      grossHours: 2,
      sourceBreakHours: 0,
      sourceNetHours: 2,
      lunchAdjustmentHours: 0,
      breakDifferenceHours: 0,
      netHours: 2,
      allocatedHours: 2,
      excludedHours: 0,
      pendingHours: 0,
      reviewReasons: [],
    })),
    jobs: [],
    totals: {
      grossHours: 6,
      sourceBreakHours: 0,
      sourceNetHours: 6,
      lunchAdjustmentHours: 0,
      netHours: 6,
      allocatedHours: 6,
      excludedHours: 0,
      pendingHours: 0,
    },
    warnings: [],
  },
  imports: [],
  jobs: [job],
  entries: sources.map((source, index) => ({
    ...source,
    kind: "work",
    jobName: "TEST Source",
    jobAddress: "TEST Address",
    clockIn: "08:00",
    clockOut: "10:00",
    clockInMethod: "Manual",
    clockOutMethod: "Manual",
    timeEntryType: "Work",
    crew: "TEST",
    role: "TEST",
    jobCode: null,
    employeeId: null,
    hours: 2,
    travel: false,
    laborCostCents: 0,
    billableCostCents: 0,
    sourceRow: index + 2,
    importId: "TEST-IMPORT",
    jobKey: "TEST-SOURCE",
  })),
  unassignedReceipts: [],
  receiptSource: "local_development",
  warnings: [],
};

async function fixture(page: Page, sendingEnabled = false) {
  let generation = 1;
  const approvals: LaborApprovalHistoryItem[] = [];
  const writes: Record<string, unknown>[] = [];
  const requests: URL[] = [];
  const preview = (from: string, to: string, workerNames?: string[]): LaborApprovalPreview => {
    const available = sources.filter((source) => source.date >= from && source.date <= to);
    const names = [...new Set(available.map((source) => source.workerName))].sort();
    const selected = workerNames ?? names;
    const rows = available.filter((source) => selected.includes(source.workerName));
    const hasOwner = rows.some((source) => source.workerName === "TEST Owner");
    const paid = rows.length * 1.75;
    const cost = rows.reduce(
      (sum, source) => sum + (source.date === "2026-10-01" ? 5409 : 5410),
      0,
    );
    return {
      housecallJobId: job.housecallJobId as string,
      jobName: job.name,
      address: job.address,
      fromDate: from,
      toDate: to,
      snapshotHash: `TEST-${generation}-${from}-${to}-${JSON.stringify([...selected].sort())}`,
      storageRevision: 42,
      totalHours: rows.length * 2,
      travelHours: 0,
      entryCount: rows.length,
      availableWorkers: names.map((workerName) => ({
        workerName,
        hours: available.filter((source) => source.workerName === workerName).length * 2,
      })),
      workers: [...selected]
        .filter((name) => rows.some((row) => row.workerName === name))
        .sort()
        .map((workerName) => ({
          workerName,
          hours: rows.filter((source) => source.workerName === workerName).length * 2,
          days: rows
            .filter((source) => source.workerName === workerName)
            .map((source) => ({ date: source.date, hours: 2, travelHours: 0, entryCount: 1 })),
        })),
      entries: rows.map((source) => ({
        sourceEntryId: source.id,
        workerName: source.workerName,
        date: source.date,
        sourceJobName: "TEST Source",
        clockIn: "08:00",
        clockOut: "10:00",
        sourceHours: 2,
        hours: 2,
        reason: "customer_work",
        originalUrl: "",
        sourceRow: 2,
      })),
      lunchDisclosure: "TEST paid hours include proportional lunch across the entire worker day.",
      warnings: ["TEST source warning retained"],
      blockers: hasOwner
        ? ["TEST Owner: hourly rate is unspecified."]
        : rows.length
          ? []
          : ["No selected hours."],
      unresolved: { entryCount: 1, hours: 0.25 },
      costEstimate: {
        policyDescription:
          "TEST proportional lunch and chronological Thursday overtime after 40 hours.",
        paidHours: paid,
        regularHours: rows.length * 1.5,
        overtimeHours: rows.length * 0.25,
        totalCostCents: hasOwner ? null : cost,
        unpricedHours: hasOwner ? 1.75 : 0,
        workers: [...new Set(rows.map((row) => row.workerName))].map((workerName) => ({
          workerName,
          hourlyRateCents: workerName === "TEST Owner" ? null : 2885,
          overtimeMultiplier: 1.5,
          paidHours: rows.filter((row) => row.workerName === workerName).length * 1.75,
          regularHours: rows.filter((row) => row.workerName === workerName).length * 1.5,
          overtimeHours: rows.filter((row) => row.workerName === workerName).length * 0.25,
          costCents: workerName === "TEST Owner" ? null : cost,
        })),
      },
      housecallInput:
        hasOwner || !rows.length
          ? null
          : {
              name: "TEST approved labor estimate",
              description: `TEST selected workers: ${selected.join(", ")}\nBefore lunch ${rows.length * 2} h; paid ${paid} h; regular ${rows.length * 1.5} h; overtime ${rows.length * 0.25} h.`,
              quantity: 1,
              unitCostCents: cost,
            },
    };
  };
  await page.context().addCookies([fixtureCookie("manager")]);
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/manager/jobs/activity", (route) => route.fulfill({ json: jobsData }));
  await page.route("**/api/manager/labor/approvals?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const data: LaborApprovalWorkspaceData = {
      capability: {
        supported: true,
        sendingEnabled,
        message: sendingEnabled ? "TEST simulated sending only." : "TEST sending is disabled.",
      },
      preview: preview(
        url.searchParams.get("fromDate") ?? "",
        url.searchParams.get("toDate") ?? "",
        url.searchParams.has("workers")
          ? JSON.parse(url.searchParams.get("workers") as string)
          : undefined,
      ),
      approvals: structuredClone(approvals),
    };
    return route.fulfill({ json: data });
  });
  await page.route("**/api/manager/labor/approvals", async (route) => {
    if (route.request().method() !== "POST") return route.abort();
    const body = route.request().postDataJSON();
    writes.push(body);
    if (body.action === "approve") {
      const current = preview(body.fromDate, body.toDate, body.workerNames);
      expect(body.expectedSnapshotHash).toBe(current.snapshotHash);
      expect(body.expectedStorageRevision).toBe(42);
      expect(body.reviewed).toBe(true);
      approvals.push({
        id: `TEST-APPROVAL-${approvals.length + 1}`,
        housecallJobId: job.housecallJobId as string,
        jobName: job.name,
        fromDate: body.fromDate,
        toDate: body.toDate,
        snapshotHash: current.snapshotHash,
        hours: current.totalHours,
        paidHours: current.costEstimate.paidHours,
        estimatedCostCents: current.costEstimate.totalCostCents as number,
        approvedWorkerNames: [...body.workerNames],
        status: "approved",
        approvedAt: "2026-10-13T12:00:00Z",
        approvedBy: "TEST-MANAGER",
        sentAt: null,
        lastError: null,
        canSend: true,
        canVerify: false,
        canRevoke: true,
      });
    } else if (body.action === "send") {
      expect(sendingEnabled).toBe(true);
      const approved = approvals.find((approval) => approval.id === body.approvalId);
      expect(approved?.snapshotHash).toBe(body.expectedSnapshotHash);
      expect(body.confirmed).toBe(true);
      if (approved)
        Object.assign(approved, {
          status: "reconciliation_required",
          canSend: false,
          canVerify: true,
          canRevoke: false,
          lastError: "TEST uncertain response; verify existing attempt.",
        });
    } else if (body.action !== "verify") throw new Error("Unexpected synthetic mutation.");
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/jobs?job=${encodeURIComponent(job.key)}`);
  const workspace = page.locator("#job-labor-approval");
  await expect(workspace.getByText("TEST Owner: hourly rate is unspecified.")).toBeVisible();
  return {
    workspace,
    approvals,
    writes,
    requests,
    changeSnapshot: () => {
      generation++;
    },
  };
}

test("requires explicit worker selection and cost-content approval while live sending is disabled", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await expect(
    state.workspace.getByRole("button", { name: "Approve hours", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Worker hours", exact: true })
    .selectOption("TEST Owner");
  await expect(
    state.workspace.getByText("2 of 2 workers selected.", { exact: false }),
  ).toBeVisible();
  await state.workspace
    .getByRole("checkbox", { name: "TEST Owner · 2.00 h before lunch", exact: true })
    .uncheck();
  await expect(
    state.workspace.getByRole("region", { name: "Exact Housecall Materials item" }),
  ).toContainText("$108.19");
  await expect(
    state.workspace.getByRole("region", { name: "Estimated job labor costs" }),
  ).toContainText("$28.85");
  expect(JSON.parse(state.requests.at(-1)?.searchParams.get("workers") ?? "[]")).toEqual([
    "TEST Worker",
  ]);
  await state.workspace
    .getByRole("checkbox", { name: /^I reviewed the exact Housecall job/ })
    .check();
  await state.workspace.getByRole("button", { name: "Approve hours", exact: true }).click();
  await expect(state.workspace.getByText("Approved · not sent", { exact: true })).toBeVisible();
  await expect(
    state.workspace.getByRole("button", { name: "Send approved hours…", exact: true }),
  ).toBeDisabled();
  expect(state.writes.map((body) => body.action)).toEqual(["approve"]);
  expect(state.writes[0]?.workerNames).toEqual(["TEST Worker"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await state.workspace.screenshot({ path: testInfo.outputPath("labor-approval-narrow.png") });
});

test("resets the checked review for changed source content or dates and restores historical worker scope before sending", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await state.workspace.getByRole("checkbox", { name: /^TEST Owner ·/ }).uncheck();
  const review = state.workspace.getByRole("checkbox", {
    name: /^I reviewed the exact Housecall job/,
  });
  await review.check();
  state.changeSnapshot();
  await state.workspace.getByRole("button", { name: "Refresh job review", exact: true }).click();
  await expect(review).not.toBeChecked();
  await review.check();
  await state.workspace.getByRole("button", { name: "Approve hours", exact: true }).click();
  await expect(state.workspace.getByText("Approved · not sent", { exact: true })).toBeVisible();
  await state.workspace.getByLabel("Last work date", { exact: true }).fill("2026-10-01");
  await expect(state.workspace.getByRole("checkbox", { name: /^TEST Owner ·/ })).toBeChecked();
  await expect(
    state.workspace.getByRole("button", { name: "Send approved hours…", exact: true }),
  ).toBeDisabled();
  await state.workspace.getByRole("button", { name: "Review this approval", exact: true }).click();
  await expect(state.workspace.getByLabel("Last work date", { exact: true })).toHaveValue(
    "2026-10-02",
  );
  await expect(state.workspace.getByRole("checkbox", { name: /^TEST Owner ·/ })).not.toBeChecked();
  await expect(
    state.workspace.getByRole("button", { name: "Send approved hours…", exact: true }),
  ).toBeEnabled();
  expect(state.writes.filter((body) => body.action === "send")).toHaveLength(0);
});

test("requires a second send confirmation and permits verification only after an uncertain attempt", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await state.workspace.getByRole("checkbox", { name: /^TEST Owner ·/ }).uncheck();
  await state.workspace
    .getByRole("checkbox", { name: /^I reviewed the exact Housecall job/ })
    .check();
  await state.workspace.getByRole("button", { name: "Approve hours", exact: true }).click();
  await state.workspace.getByRole("button", { name: "Send approved hours…", exact: true }).click();
  const send = state.workspace.getByRole("button", {
    name: "Confirm send approved hours",
    exact: true,
  });
  await expect(send).toBeDisabled();
  await state.workspace.getByRole("checkbox", { name: /^I confirm this separate send/ }).check();
  await send.click();
  await expect(state.workspace.getByText("Needs reconciliation", { exact: true })).toBeVisible();
  await expect(
    state.workspace.getByRole("button", { name: "Send approved hours…", exact: true }),
  ).toHaveCount(0);
  await expect(
    state.workspace.getByRole("button", { name: "Retry send…", exact: true }),
  ).toHaveCount(0);
  await state.workspace.getByRole("button", { name: "Verify existing send", exact: true }).click();
  await expect
    .poll(() => state.writes.map((body) => body.action))
    .toEqual(["approve", "send", "verify"]);
});

test("avoids timed full-preview polling and refreshes changed reviews on visible focus or visibility", async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  await state.workspace.getByRole("checkbox", { name: /^TEST Owner ·/ }).uncheck();
  const review = state.workspace.getByRole("checkbox", {
    name: /^I reviewed the exact Housecall job/,
  });
  await review.check();
  const before = state.requests.length;
  state.changeSnapshot();
  await page.clock.runFor(90_000);
  expect(state.requests).toHaveLength(before);
  await expect(review).toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.requests.length).toBe(before + 1);
  await expect(review).not.toBeChecked();
  await review.check();
  state.changeSnapshot();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => state.requests.length).toBe(before + 2);
  await expect(review).not.toBeChecked();
  expect(state.writes).toHaveLength(0);
});
