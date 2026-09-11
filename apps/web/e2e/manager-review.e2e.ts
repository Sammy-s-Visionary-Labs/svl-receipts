import { expect, type Page, test } from "@playwright/test";
import type { HousecallExportPreview } from "../lib/housecall/preview";
import type { ManagerJob, ReceiptDetail } from "../lib/manager/review-contract";
import { fixtureCookie, fixtureSession } from "./fixture-auth.mjs";

const id = "44100000-0000-4000-8000-000000000001";
const attemptId = "44300000-0000-4000-8000-000000000001";
const intentId = "44400000-0000-4000-8000-000000000001";
const job = (id: string, label: string): ManagerJob => ({
  id,
  label,
  customer: "River family",
  number: id === "job-a" ? "1042" : "1043",
  status: "Scheduled",
  scheduledAt: "2026-09-08T12:00:00Z",
  technicians: ["Sam"],
  active: true,
  source: null,
});
const jobs = [job("job-a", "Kitchen renovation"), job("job-b", "Kitchen renovation")];
function receipt(): ReceiptDetail {
  const original = {
    vendor: "Copperfield Supply",
    purchaseDate: "2026-09-07",
    invoiceNumber: "INV-2042",
    ticketNumber: "",
    category: "Materials",
    referenceTotal: "42.00",
    managerNotes: "",
    lines: [
      {
        id: "line-one",
        sourceIndex: 0,
        description: "Copper pipe",
        qty: "1.005",
        uom: "ft",
        unitCost: "1.00",
        jobId: "job-a",
      },
      {
        id: "line-two",
        sourceIndex: 1,
        description: "Elbow connector",
        qty: "2",
        uom: "ea",
        unitCost: "3.25",
        jobId: "job-b",
      },
    ],
  };
  return {
    id,
    status: "needs_review",
    submittedAt: "2026-09-07T12:00:00Z",
    version: 0,
    extractionId: null,
    draft: structuredClone(original),
    original,
    confidence: { vendor: 0.6 },
    gps: null,
    pageCount: 1,
    editable: true,
    steps: [],
    events: [
      {
        id: "event-one",
        action: "extraction_recorded",
        actor: "Extraction service",
        createdAt: "2026-09-07T12:00:01Z",
        version: 1,
        reason: null,
        changes: {},
      },
    ],
    nextEventCursor: null,
    suggestions: [
      {
        ...jobs[0],
        source: "Invoice job reference",
        suggestionId: "44500000-0000-4000-8000-000000000001",
      },
    ],
    correctionPending: false,
    clarification: null,
    canonicalReceiptId: null,
  };
}
async function setup(
  page: Page,
  options: { role?: "manager" | "admin"; historical?: boolean } = {},
) {
  const state = {
    detail: receipt(),
    requests: [] as Record<string, unknown>[],
    conflict: false,
    imageFailure: false,
    networkFailure: false,
  };
  if (options.historical) {
    state.detail.editable = false;
    state.detail.status = "partial_success";
    state.detail.steps = [
      {
        id: "success",
        intentId,
        jobId: "job-a",
        lineId: null,
        step: "attachment",
        status: "succeeded",
        externalId: "attachment-42",
        error: null,
        createdAt: "2026-09-07T12:30:00Z",
        retryQueued: false,
      },
      {
        id: attemptId,
        intentId,
        jobId: "job-b",
        lineId: "line-two",
        step: "job_cost",
        status: "retryable_failure",
        externalId: null,
        error: "timeout",
        createdAt: "2026-09-07T12:31:00Z",
        retryQueued: false,
      },
    ];
  }
  await page.context().addCookies([fixtureCookie(options.role ?? "manager")]);
  await page.route(`**/api/manager/receipts/${id}`, (route) =>
    route.fulfill({ json: state.detail }),
  );
  await page.route("**/api/manager/jobs?*", (route) => route.fulfill({ json: { jobs } }));
  await page.route(`**/api/receipts/${id}/image`, (route) =>
    state.imageFailure
      ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({
          json: { url: "/ra4-fixture-image.svg", expiresAt: "2099-01-01T00:00:00Z" },
        }),
  );
  await page.route("**/ra4-fixture-image.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#fffdf6"/><g font-family="monospace" fill="#263c30"><text x="50" y="80" font-size="29">COPPERFIELD SUPPLY</text><text x="50" y="130" font-size="18">Receipt INV-2042 · 09/07/2026</text><text x="50" y="240" font-size="21">Copper pipe        1.005 x 1.00</text><text x="50" y="290" font-size="21">Elbow connector    2 x 3.25</text><text x="50" y="440" font-size="24">Total reference      $42.00</text><text x="50" y="700" font-size="18">SYNTHETIC TEST RECEIPT</text></g></svg>',
    }),
  );
  await page.route(`**/api/manager/receipts/${id}/review`, async (route) => {
    const body = route.request().postDataJSON();
    state.requests.push(body);
    if (state.conflict)
      return route.fulfill({ status: 409, json: { error: { message: "conflict" } } });
    if (state.networkFailure)
      return route.fulfill({ status: 503, json: { error: { message: "Service unavailable" } } });
    state.detail.draft = body.draft;
    state.detail.version++;
    state.detail.clarification = body.decision === "request_clarification" ? body.reason : null;
    if (body.decision === "approve") {
      state.detail.status = "approved";
      state.detail.editable = false;
    }
    if (body.decision === "decline") {
      state.detail.status = "rejected";
      state.detail.editable = false;
    }
    if (body.decision === "mark_duplicate") {
      state.detail.status = "duplicate";
      state.detail.editable = false;
      state.detail.canonicalReceiptId = body.canonicalReceiptId;
    }
    state.detail.events.push({
      id: `review-${state.detail.version}`,
      action: body.decision,
      actor: "Manager",
      createdAt: "2026-09-07T13:00:00Z",
      version: state.detail.version,
      reason: body.reason,
      changes: { vendor: { before: state.detail.original.vendor, after: body.draft.vendor } },
    });
    await route.fulfill({
      json: { id, version: state.detail.version, status: state.detail.status },
    });
  });
  await page.route(`**/api/manager/receipts/${id}/recovery`, async (route) => {
    const body = route.request().postDataJSON();
    state.requests.push(body);
    if (body.kind === "retry") state.detail.steps[1].retryQueued = true;
    else state.detail.correctionPending = true;
    await route.fulfill({
      status: 202,
      json: { id: "command", status: "pending", message: "Recovery request queued." },
    });
  });
  await page.goto(`/receipts/${id}`);
  await expect(page.getByRole("heading", { name: "Receipt details", exact: true })).toBeVisible();
  return state;
}
test("edits a versioned draft and preserves original evidence across reload", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Vendor *", { exact: true }).fill("Reviewed supply");
  await page.getByRole("button", { name: "Save for later", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  expect(state.requests[0]).toMatchObject({ decision: "save_draft", version: 0 });
  await page.reload();
  await expect(page.getByLabel("Vendor *", { exact: true })).toHaveValue("Reviewed supply");
  await page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Edited" }) })
    .first()
    .getByText("Edited", { exact: true })
    .click();
  await expect(page.getByText("Extracted: Copperfield Supply")).toBeVisible();
  await expect(page.getByText("save draft", { exact: true })).toBeVisible();
});
test("shows autofilled date and per-line jobs as editable choices without saving on open", async ({
  page,
}) => {
  const state = await setup(page);
  state.detail.draft.purchaseDate = "2026-07-10";
  state.detail.automaticJobAssignments = [
    {
      lineIndex: 0,
      jobId: "job-a",
      sourceText: "River",
      message: "Automatically matched from “River”. Verify the job before approval.",
    },
  ];
  await page.reload();
  await expect(page.getByLabel("Purchase date *", { exact: true })).toHaveValue("2026-07-10");
  const selected = page.getByLabel("Housecall job", { exact: true }).first();
  await expect(selected).toHaveValue("job-a");
  await expect(
    page.getByText("Automatically matched from “River”. Verify the job before approval."),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await selected.selectOption("job-b");
  await expect(selected).toHaveValue("job-b");
  await expect(
    page.getByText("Automatically matched from “River”. Verify the job before approval."),
  ).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});
test("stale and failed saves preserve local edits and never show success", async ({ page }) => {
  const state = await setup(page);
  state.conflict = true;
  await page.getByLabel("Vendor *", { exact: true }).fill("My unsaved correction");
  await page.getByRole("button", { name: "Save for later", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This receipt changed" })).toContainText(
    "Your edits are preserved",
  );
  await expect(page.getByLabel("Vendor *", { exact: true })).toHaveValue("My unsaved correction");
  state.conflict = false;
  state.networkFailure = true;
  await page.getByRole("button", { name: "Save for later", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Service unavailable" })).toContainText(
    "Service unavailable",
  );
  await expect(page.getByText("Draft saved.", { exact: true })).toHaveCount(0);
});
test("checks decimal amounts, missing job and exact two-job approval", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole("status", { name: "Material 1 extended cost" })).toHaveText("$1.01");
  await page.getByLabel("Quantity", { exact: true }).first().fill("-1");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(
    page.getByText("Use a positive quantity with up to three decimal places."),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await page.getByLabel("Quantity", { exact: true }).first().fill("1.005");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(page.getByText(/Housecall supports at most two decimal places/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
  await page.getByLabel("Quantity", { exact: true }).first().fill("1.01");
  await page.getByLabel("Housecall job", { exact: true }).first().selectOption("");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(page.getByText("Choose a Housecall job. Overhead is not enabled.")).toBeVisible();
  await page.getByLabel("Housecall job", { exact: true }).first().selectOption("job-a");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 lines to 2 jobs");
  await expect(dialog).toContainText(
    "Live Housecall writes require separate explicit approval before any data is sent.",
  );
  await expect(dialog.getByRole("button", { name: "Approve receipt", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(
    page.getByText(
      "Receipt approved. Export is prepared; live Housecall writes require separate explicit approval.",
    ),
  ).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0].taxExcluded).toBe(true);
});
test("loads the frozen export preview on demand and checks uncertain results without a send action", async ({
  page,
}) => {
  await setup(page, { historical: true });
  const calls: string[] = [];
  const preview: HousecallExportPreview = {
    receiptId: id,
    intentId,
    payloadHash: "a".repeat(64),
    previewOnly: true,
    liveWritesEnabled: false,
    separateApprovalRequired: true,
    taxExcluded: true,
    totalMaterialCostCents: 202,
    blockedReasons: ["live_writes_disabled", "destination_not_approved"],
    jobs: ["job-a", "job-b"].map((jobId, index) => ({
      id: jobId,
      label: "Same synthetic customer",
      destinationAllowed: index === 0,
      unavailable: false,
      materialCostCents: 101,
      images: [
        {
          stepId: `${jobId}-page-0`,
          pageIndex: 0,
          status: "succeeded",
          externalId: `${jobId}-image`,
        },
        { stepId: `${jobId}-page-1`, pageIndex: 1, status: "reconcile_required", externalId: null },
      ],
      lines: [
        {
          stepId: `${jobId}-line`,
          description: "Synthetic fractional material",
          qty: 1.005,
          uom: "ton",
          unitCostCents: 100,
          extendedCostCents: 101,
          status: "ready",
          externalId: null,
        },
      ],
    })),
  };
  await page.route(`**/api/manager/receipts/${id}/export-preview`, (route) => {
    calls.push(route.request().method());
    return route.fulfill({ json: preview });
  });
  await page.route(`**/api/manager/receipts/${id}/export-reconcile`, (route) => {
    calls.push(`reconcile:${route.request().method()}`);
    return route.fulfill({ json: { completed: 0, unresolved: 2 } });
  });
  expect(calls).toEqual([]);
  const section = page.getByRole("region", { name: "Housecall export preview" });
  await section.getByRole("button", { name: "Load export preview", exact: true }).click();
  await expect(section).toContainText("Live Housecall writes are disabled.");
  await expect(section).toContainText("$2.02 material costs · Tax excluded");
  await expect(section.getByRole("heading", { name: "Same synthetic customer" })).toHaveCount(2);
  await expect(section.getByText("job-a", { exact: true })).toBeVisible();
  await expect(section.getByText("job-b", { exact: true })).toBeVisible();
  await expect(section.getByText("Page 1 · Verified", { exact: false })).toHaveCount(2);
  await expect(section.getByText("Page 2 · Verification required", { exact: false })).toHaveCount(
    2,
  );
  await expect(section.getByText("1.005 ton × $1.00 = $1.01", { exact: true })).toHaveCount(2);
  expect(calls).toEqual(["GET"]);
  await expect(section.getByRole("button", { name: /send|approve|upload/i })).toHaveCount(0);
  await section.getByText("Frozen plan reference for approval", { exact: true }).click();
  await expect(section.getByText("a".repeat(64), { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Check Housecall result", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("Housecall was checked.");
  expect(calls).toEqual(["GET", "reconcile:POST", "GET"]);
  // A worker killed mid-request can remain in_progress after its lease and
  // approval expire. Read-only recovery must remain visible with writes disabled.
  for (const job of preview.jobs) job.images[1].status = "in_progress";
  await section.getByRole("button", { name: "Refresh export preview", exact: true }).click();
  await expect(section.getByText("Page 2 · In progress", { exact: false })).toHaveCount(2);
  await expect(
    section.getByRole("button", { name: "Check Housecall result", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});
test("job bulk assignment requires confirmation and adding/deleting keeps focus", async ({
  page,
}) => {
  await setup(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Apply to all", exact: true }).click();
  await expect(page.getByLabel("Housecall job", { exact: true }).nth(1)).toHaveValue("job-b");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Apply to all", exact: true }).click();
  await expect(page.getByLabel("Housecall job", { exact: true }).nth(1)).toHaveValue("job-a");
  await page.getByRole("button", { name: "+ Add material", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true }).nth(2)).toBeFocused();
  await page.getByRole("button", { name: "Delete material 2", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveCount(2);
  await expect(page.getByLabel("Description", { exact: true }).first()).toBeFocused();
});
test("keeps saved older jobs outside the search page and blocks unavailable or stale shortcuts", async ({
  page,
}) => {
  const state = await setup(page);
  const oldJob: ManagerJob = {
    ...job("saved-outside-top-50", "Historic saved assignment"),
    active: false,
    status: "complete unrated",
    source: "housecall",
    syncedAt: "2026-09-09T12:00:00Z",
    stale: false,
    unavailable: false,
  };
  const removed: ManagerJob = {
    ...job("removed-from-housecall", "Current unavailable destination"),
    active: false,
    status: "pro canceled",
    source: "housecall",
    syncedAt: "2026-09-09T12:00:00Z",
    stale: false,
    unavailable: true,
  };
  state.detail.draft.lines[0].jobId = oldJob.id;
  state.detail.draft.lines[1].jobId = removed.id;
  state.detail.assignedJobs = [oldJob, removed];
  state.detail.suggestions = [
    {
      ...job("stale-suggestion", "Stale extracted suggestion"),
      source: "housecall",
      syncedAt: "2020-01-01T00:00:00Z",
      stale: true,
      unavailable: false,
      suggestionId: "stale-suggestion-id",
    },
    {
      ...job(removed.id, "Earlier extraction said this job was available"),
      source: "Stored suggestion",
      stale: false,
      unavailable: false,
      suggestionId: "removed-suggestion-id",
      sourceIndex: 1,
    },
  ];
  const searchPage = Array.from({ length: 50 }, (_, index) =>
    job(`search-${index}`, `Search job ${index}`),
  );
  const scopes: string[] = [];
  await page.route("**/api/manager/jobs?*", (route) => {
    scopes.push(new URL(route.request().url()).searchParams.get("scope") ?? "");
    return route.fulfill({ json: { jobs: searchPage } });
  });
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.reload();
  const firstJob = page.getByLabel("Housecall job", { exact: true }).first();
  const secondJob = page.getByLabel("Housecall job", { exact: true }).nth(1);
  await expect(firstJob).toHaveValue(oldJob.id);
  await expect(firstJob.getByRole("option", { name: /Historic saved assignment/ })).toBeEnabled();
  await expect(firstJob.getByRole("option", { name: /Search job 49/ })).toHaveCount(1);
  expect(searchPage.some((candidate) => candidate.id === oldJob.id)).toBe(false);
  await expect(secondJob).toHaveValue(removed.id);
  await expect(
    secondJob.getByRole("option", { name: /Current unavailable destination.*Unavailable/ }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply to all", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use for this line", exact: true })).toBeDisabled();
  await expect(page.getByText("This job is unavailable.", { exact: true })).toBeVisible();
  await expect(
    firstJob.getByRole("option", { name: /Stale extracted suggestion.*Refresh needed/ }),
  ).toHaveCount(1);
  await page.getByLabel("Include all older jobs", { exact: true }).check();
  await expect.poll(() => scopes.includes("all")).toBe(true);
  await expect(firstJob).toHaveValue(oldJob.id);
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(
    page.getByText("This Housecall job is unavailable. Choose an available job.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.requests).toEqual([]);
  expect(mutations).toEqual([]);
  // A fresh replacement can reach review confirmation while preserving the saved older destination.
  await secondJob.selectOption("search-0");
  await page.getByLabel("Quantity", { exact: true }).first().fill("1.01");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Historic saved assignment");
  await expect(page.getByRole("dialog")).toContainText(oldJob.id);
  expect(mutations).toEqual([]);
});
test("image refresh preserves edits, zoom and rotation", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Vendor *", { exact: true }).fill("Unsaved");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Rotate", exact: true }).click();
  state.imageFailure = true;
  await page.getByRole("button", { name: "Refresh image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry image", exact: true })).toBeVisible();
  state.imageFailure = false;
  await page.getByRole("button", { name: "Retry image", exact: true }).click();
  await expect(page.getByRole("img", { name: "Original submitted receipt" })).toHaveCSS(
    "transform",
    "matrix(0, 1, -1, 0, 0, 0)",
  );
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Vendor *", { exact: true })).toHaveValue("Unsaved");
});
test("manager can inspect every receipt page without losing draft edits", async ({ page }) => {
  const state = await setup(page);
  state.detail.pageCount = 2;
  const pages: string[] = [];
  await page.route(`**/api/receipts/${id}/image?*`, (route) => {
    pages.push(new URL(route.request().url()).searchParams.get("page") ?? "");
    return route.fulfill({
      json: { url: "/ra4-fixture-image.svg", expiresAt: "2099-01-01T00:00:00Z" },
    });
  });
  await page.reload();
  await page.getByLabel("Vendor *", { exact: true }).fill("Unsaved page review");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(
    page.getByAltText("Original submitted receipt, page 2", { exact: true }),
  ).toBeVisible();
  expect(pages.length).toBeGreaterThan(0);
  expect(new Set(pages)).toEqual(new Set(["1"]));
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByAltText("Original submitted receipt", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Vendor *", { exact: true })).toHaveValue("Unsaved page review");
  expect(state.requests).toHaveLength(0);
});
test("test-session approval explains automatic delivery and refreshes export completion", async ({
  page,
}) => {
  const state = await setup(page);
  state.detail.automaticExport = true;
  state.detail.draft.lines[0].qty = "1.01";
  await page.reload();
  await page.route(`**/api/manager/receipts/${id}/review`, async (route) => {
    state.requests.push(route.request().postDataJSON());
    state.detail.editable = false;
    state.detail.status = "approved";
    return route.fulfill({ json: { id, status: "approved", exportAuthorized: true } });
  });
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("automatically to the selected Housecall jobs");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(page.getByText(/Receipt approved. Sending the receipt/)).toBeVisible();
  state.detail.status = "exported";
  await expect(page.getByText(`${id} · exported`, { exact: true })).toBeVisible({ timeout: 10000 });
  expect(state.requests).toHaveLength(1);
});
for (const decision of ["Decline", "Mark duplicate", "Request clarification"])
  test(`${decision} requires a reason and creates no approval request`, async ({ page }) => {
    const state = await setup(page);
    await page.getByRole("button", { name: decision, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Confirm decision", exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("Reason *", { exact: true }).fill("Please check this receipt");
    if (decision === "Mark duplicate")
      await dialog
        .getByLabel("Canonical receipt ID *", { exact: true })
        .fill("44100000-0000-4000-8000-000000000002");
    await dialog.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].decision).not.toBe("approve");
  });
test("historical receipt is read-only and retries only failed work", async ({ page }) => {
  const state = await setup(page, { historical: true });
  await expect(page.getByLabel("Vendor *", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Retry this failed step", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Retry this failed step", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason *", { exact: true }).fill("Reconcile timeout");
  await dialog.getByRole("button", { name: "Queue failed-step retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry this failed step", exact: true }),
  ).toBeDisabled();
  expect(state.requests[0]).toMatchObject({ kind: "retry", attemptId, intentId });
  await expect(page.getByText("External ID:")).toContainText("attachment-42");
  await expect(page.getByRole("button", { name: "Start correction", exact: true })).toHaveCount(0);
});
test("administrator sees old/new correction impact and records an explicit proposal", async ({
  page,
}) => {
  const state = await setup(page, { historical: true, role: "admin" });
  await page.getByRole("button", { name: "Start correction", exact: true }).click();
  await page.getByLabel("Quantity", { exact: true }).first().fill("2");
  await page.getByRole("button", { name: "Review correction impact", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Posted review", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Proposed review", { exact: true })).toBeVisible();
  await dialog.getByLabel("Reason *", { exact: true }).fill("Quantity correction");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Record correction request", exact: true }).click();
  await expect(
    page.getByText("A correction is awaiting reconciliation. Posted history is preserved."),
  ).toBeVisible();
  expect(state.requests[0]).toMatchObject({ kind: "correction", confirmImpact: true });
  expect(state.detail.draft.lines[0].qty).toBe("1.005");
});
test("narrow receipt review remains usable without horizontal page overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByLabel("Vendor *", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save for later", exact: true }).scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("manager-review-narrow.png"), fullPage: true });
});
test("desktop review visual and keyboard image pan", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1512, height: 982 });
  await setup(page);
  await expect(page.getByRole("button", { name: "Approve receipt", exact: true })).toBeInViewport();
  const viewport = page.getByRole("region", { name: "Receipt image. Use arrow keys to pan." });
  await viewport.focus();
  await page.keyboard.press("ArrowDown");
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("manager-review-desktop.png"),
    fullPage: true,
  });
});

test("real manager API guards deny worker and disabled-user requests", async ({ request }) => {
  for (const identity of ["worker", "disabled"] as const) {
    const token = fixtureSession(identity).access_token;
    const headers = { authorization: `Bearer ${token}` };
    const expected = identity === "worker" ? 403 : 401;
    for (const suffix of ["", "/events"]) {
      const response = await request.get(`/api/manager/receipts/${id}${suffix}`, { headers });
      expect(response.status()).toBe(expected);
    }
    for (const suffix of ["review", "recovery"]) {
      const response = await request.post(`/api/manager/receipts/${id}/${suffix}`, {
        headers,
        data: {},
      });
      expect(response.status()).toBe(expected);
    }
    expect((await request.get("/api/manager/jobs", { headers })).status()).toBe(expected);
  }
});

test("RA5 explains extraction and line matches, keeps duplicate decisions explicit, and uses category IDs", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  state.detail.extractionId = "44900000-0000-4000-8000-000000000001";
  await page.route(`**/api/manager/receipts/${id}/evidence?*`, (route) =>
    route.fulfill({
      json: {
        evidence: [{ field: "vendor", text: "COPPERFIELD SUPPLY", page_index: 0, confidence: 0.9 }],
      },
    }),
  );
  state.detail.categories = [
    { id: "materials", label: "Materials", active: true, keywords: ["pipe"], version: 1 },
    { id: "old", label: "Old category", active: false, keywords: [], version: 1 },
  ];
  state.detail.draft.category = "materials";
  state.detail.original.category = "materials";
  state.detail.warnings = [
    {
      code: "total_mismatch",
      field: "receipt_total",
      message: "Printed total differs from calculated material costs plus tax.",
    },
  ];
  state.detail.categorySuggestion = {
    categoryId: "materials",
    confidence: 0.7,
    reasons: [{ code: "keywords", message: "Pipe matches the approved Materials category." }],
    scoringVersion: "ra5-rules-v1",
  };
  state.detail.suggestions = [
    {
      ...jobs[0],
      suggestionId: "44500000-0000-4000-8000-000000000001",
      score: 1002,
      reasons: [
        {
          code: "exact_reference",
          message: "Printed job reference matches.",
          evidence: ["PO TEST-1042"],
        },
      ],
    },
    {
      ...jobs[0],
      suggestionId: "44500000-0000-4000-8000-000000000002",
      sourceIndex: 1,
      score: 2002,
      reasons: [
        {
          code: "exact_reference",
          message: "Reference on this material line matches this catalog job.",
          evidence: ["Line 2: TEST-1042"],
        },
      ],
    },
  ];
  state.detail.duplicates = [
    {
      id: "44600000-0000-4000-8000-000000000001",
      receiptId: "44100000-0000-4000-8000-000000000002",
      score: 100,
      status: "pending",
      reasons: [{ code: "exact_image_hash", message: "All receipt image checksums match." }],
    },
    {
      id: "44600000-0000-4000-8000-000000000002",
      receiptId: "44100000-0000-4000-8000-000000000003",
      score: 75,
      status: "pending",
      reasons: [{ code: "ticket", message: "Vendor and ticket number match." }],
    },
  ];
  let dismissed: unknown = null;
  await page.route(`**/api/manager/receipts/${id}/duplicates`, async (route) => {
    dismissed = route.request().postDataJSON();
    await route.fulfill({ json: { status: "dismissed" } });
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Category *" })).toHaveValue("materials");
  await page.getByText("Source evidence for this extraction", { exact: true }).click();
  await page.getByRole("button", { name: "Load source evidence", exact: true }).click();
  await expect(page.locator("blockquote", { hasText: "COPPERFIELD SUPPLY" })).toBeVisible();
  await expect(
    page.getByText("Printed total differs from calculated material costs plus tax."),
  ).toBeVisible();
  await page.getByText("Printed job reference matches.", { exact: true }).click();
  await expect(page.getByText("PO TEST-1042", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use for this line", exact: true }).click();
  await expect(page.getByLabel("Housecall job", { exact: true }).nth(1)).toHaveValue("job-a");
  await page.getByRole("button", { name: "Save for later", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  expect(state.requests[0]).toMatchObject({
    decision: "save_draft",
    draft: {
      category: "materials",
      lines: [{}, { jobId: "job-a", suggestionId: "44500000-0000-4000-8000-000000000002" }],
    },
  });
  await page.getByRole("button", { name: "Dismiss candidate", exact: true }).first().click();
  await expect(
    page.getByText("Candidate dismissed; approval is not blocked by this candidate."),
  ).toBeVisible();
  expect(dismissed).toEqual({
    decision: "dismiss",
    candidateId: "44600000-0000-4000-8000-000000000001",
  });
  await page.getByRole("button", { name: "Review as duplicate", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Canonical receipt ID *")).toHaveValue(
    "44100000-0000-4000-8000-000000000003",
  );
  expect(state.requests).toHaveLength(1);
  await dialog.getByLabel("Reason *", { exact: true }).fill("Verified the same original ticket.");
  await dialog.getByRole("button", { name: "Confirm decision", exact: true }).click();
  expect(state.requests[1]).toMatchObject({
    decision: "mark_duplicate",
    canonicalReceiptId: "44100000-0000-4000-8000-000000000003",
  });
  expect(state.requests.some((r) => r.decision === "approve")).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("ra5-intelligence-review.png"),
    fullPage: true,
  });
});

test("RA5 administrator configures stable category IDs and preserves deactivated history", async ({
  page,
}, testInfo) => {
  await page.context().addCookies([fixtureCookie("admin")]);
  const categories: Array<{
    id: string;
    label: string;
    active: boolean;
    keywords: string[];
    version: number;
  }> = [];
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/manager/categories", (route) => route.fulfill({ json: { categories } }));
  await page.route("**/api/admin/categories", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const existing = categories.findIndex((category) => category.id === body.id);
    const updated = { ...body, version: existing < 0 ? 1 : categories[existing].version + 1 };
    if (existing < 0) categories.push(updated);
    else categories[existing] = updated;
    await route.fulfill({ json: updated });
  });
  await page.goto("/settings");
  await expect(page.getByText("No categories configured.")).toBeVisible();
  await page.getByLabel("Stable category ID", { exact: true }).fill("materials");
  await page.getByLabel("Display name", { exact: true }).fill("Materials");
  await page
    .getByLabel("Suggestion keywords (comma separated)", { exact: true })
    .fill("pipe, gravel");
  await page.getByRole("button", { name: "Save category", exact: true }).click();
  await expect(page.getByText("Category configuration saved.")).toBeVisible();
  expect(requests[0]).toEqual({
    id: "materials",
    label: "Materials",
    active: true,
    keywords: ["pipe", "gravel"],
  });
  await page.getByRole("button", { name: "Materials", exact: true }).click();
  await page.getByLabel("Active for new approvals", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save category", exact: true }).click();
  await expect(
    page.getByText("· Inactive · materials · version 2", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download sanitized evaluation JSON" }),
  ).toHaveAttribute("href", "/api/admin/intelligence/evaluation");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ra5-category-settings.png"), fullPage: true });
});

test("administrator confirms manual handoff and sees closed state without export success", async ({
  page,
}) => {
  await setup(page, { historical: true, role: "admin" });
  let closed = false;
  const requests: unknown[] = [];
  await page.route(`**/api/manager/receipts/${id}/export-preview`, (route) =>
    route.fulfill({
      json: {
        receiptId: id,
        intentId: closed ? null : intentId,
        payloadHash: "a".repeat(64),
        closedForManualHandling: closed,
        previewOnly: true,
        liveWritesEnabled: false,
        separateApprovalRequired: true,
        taxExcluded: true,
        totalMaterialCostCents: 101,
        blockedReasons: closed ? ["no_current_intent"] : ["unsupported_quantity_precision"],
        jobs: closed
          ? []
          : [
              {
                id: "job-a",
                label: "Synthetic test",
                destinationAllowed: true,
                materialCostCents: 101,
                images: [],
                lines: [
                  {
                    stepId: "line",
                    description: "Synthetic material",
                    qty: 1.005,
                    unitCostCents: 100,
                    extendedCostCents: 101,
                    status: "reconcile_required",
                    externalId: null,
                  },
                ],
              },
            ],
      },
    }),
  );
  await page.route(`**/api/admin/receipts/${id}/close-export`, (route) => {
    requests.push(route.request().postDataJSON());
    closed = true;
    return route.fulfill({ json: { closed: true, exported: false } });
  });
  const region = page.getByRole("region", { name: "Housecall export preview" });
  await region.getByRole("button", { name: "Load export preview", exact: true }).click();
  await region.getByText("Stop this export for manual handling", { exact: true }).click();
  const button = region.getByRole("button", { name: "Stop automatic export", exact: true });
  await expect(button).toBeDisabled();
  await region
    .getByLabel("Manual handling reason", { exact: true })
    .fill("Provider rounded the quantity; remaining synthetic costs handled manually.");
  await expect(button).toBeDisabled();
  await region.getByRole("checkbox").check();
  await button.click();
  await expect(region).toContainText("Automatic export stopped for manual handling.");
  await expect(region).not.toContainText("Approve the receipt to freeze its export plan.");
  expect(requests).toEqual([
    expect.objectContaining({ intentId, payloadHash: "a".repeat(64), confirmStop: true }),
  ]);
});

test("refreshes the job catalog without losing manager edits or approving the receipt", async ({
  page,
}) => {
  const state = await setup(page);
  let refreshed = false;
  await page.route("**/api/manager/jobs", (route) => {
    expect(route.request().method()).toBe("POST");
    refreshed = true;
    return route.fulfill({ json: { count: 990, scanned: 990 } });
  });
  await page.getByLabel("Vendor *", { exact: true }).fill("Manager's saved choice");
  await page.getByRole("button", { name: "Refresh Housecall jobs", exact: true }).click();
  await expect.poll(() => refreshed).toBe(true);
  await expect(
    page.getByRole("button", { name: "Refresh Housecall jobs", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Vendor *", { exact: true })).toHaveValue("Manager's saved choice");
  expect(state.requests).toEqual([]);
});
