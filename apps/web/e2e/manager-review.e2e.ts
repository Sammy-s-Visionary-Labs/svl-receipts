import { expect, type Page, test } from "@playwright/test";
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
  await page.getByRole("button", { name: "Approve & send to Housecall", exact: true }).click();
  await expect(
    page.getByText("Use a positive quantity with up to three decimal places."),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await page.getByLabel("Quantity", { exact: true }).first().fill("1.005");
  await page.getByLabel("Housecall job", { exact: true }).first().selectOption("");
  await page.getByRole("button", { name: "Approve & send to Housecall", exact: true }).click();
  await expect(page.getByText("Choose a Housecall job. Overhead is not enabled.")).toBeVisible();
  await page.getByLabel("Housecall job", { exact: true }).first().selectOption("job-a");
  await page.getByRole("button", { name: "Approve & send to Housecall", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 lines to 2 jobs");
  await expect(
    dialog.getByRole("button", { name: "Approve & send to Housecall", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve & send to Housecall", exact: true }).click();
  await expect(page.getByText("Approved. Housecall export is queued.")).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0].taxExcluded).toBe(true);
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
  await expect(
    page.getByRole("button", { name: "Approve & send to Housecall", exact: true }),
  ).toBeInViewport();
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
