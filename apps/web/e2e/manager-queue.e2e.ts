import { expect, type Page, type Route, test } from "@playwright/test";
import {
  DEFAULT_QUEUE_FILTERS,
  type QueueFilters,
  type QueueReceipt,
  type QueueResponse,
} from "../lib/manager/queue-contract";
import { FIXTURE_USERS, fixtureCookie, fixtureSession } from "./fixture-auth.mjs";

const QUEUE_URL = /\/api\/manager\/queue(?:\?|$)/;
const AS_OF = "2026-09-07T12:00:00.000Z";
const RECEIPTS: QueueReceipt[] = [
  {
    id: "b2700000-0000-4000-8000-000000000001",
    status: "needs_review",
    submittedAt: "2026-09-01T10:00:00.000Z",
    submitter: { id: FIXTURE_USERS.worker.id, label: "Worker a2700000" },
    vendor: "Copperfield Supply",
    reference: "INV-1042",
    referenceTotalCents: 12845,
    pageCount: 2,
    thumbnailUrl: "/fixture-receipt.svg",
    suggestedJob: { id: "fixture-job-14", label: "#14 · Orchard House", source: "document" },
    confidence: 0.68,
    duplicate: "unmarked",
    warnings: ["low_confidence"],
    housecallStatus: "not_started",
    extractionId: "c2700000-0000-4000-8000-000000000001",
    latestReviewDecision: null,
  },
  {
    id: "b2700000-0000-4000-8000-000000000002",
    status: "needs_review",
    submittedAt: "2026-09-02T13:00:00.000Z",
    submitter: { id: "a2700000-0000-4000-8000-000000000005", label: "Worker b2800000" },
    vendor: "Northgate Tools",
    reference: "TICKET-201",
    referenceTotalCents: 4599,
    pageCount: 1,
    thumbnailUrl: "/fixture-receipt.svg",
    suggestedJob: null,
    confidence: 0.96,
    duplicate: "unmarked",
    warnings: ["job_suggestion_unavailable"],
    housecallStatus: "not_started",
    extractionId: "c2700000-0000-4000-8000-000000000002",
    latestReviewDecision: "save_draft",
  },
  {
    id: "b2700000-0000-4000-8000-000000000003",
    status: "needs_review",
    submittedAt: "2026-09-03T15:30:00.000Z",
    submitter: { id: FIXTURE_USERS.worker.id, label: "Worker a2700000" },
    vendor: null,
    reference: null,
    referenceTotalCents: null,
    pageCount: 1,
    thumbnailUrl: null,
    suggestedJob: null,
    confidence: null,
    duplicate: "unmarked",
    warnings: ["extraction_unavailable", "job_suggestion_unavailable"],
    housecallStatus: "not_started",
    extractionId: null,
    latestReviewDecision: null,
  },
];

function responseFor(
  url: URL,
  receipts = RECEIPTS,
  nextCursor: string | null = null,
): QueueResponse {
  const filters = { ...DEFAULT_QUEUE_FILTERS };
  for (const key of Object.keys(filters) as (keyof QueueFilters)[]) {
    const value = url.searchParams.get(key);
    if (value !== null) Object.assign(filters, { [key]: key === "limit" ? Number(value) : value });
  }
  return { receipts, filters, nextCursor, asOf: AS_OF };
}

async function fulfillQueue(route: Route, receipts = RECEIPTS, nextCursor: string | null = null) {
  await route.fulfill({ json: responseFor(new URL(route.request().url()), receipts, nextCursor) });
}

async function routeQueue(page: Page, handler: (route: Route, url: URL) => Promise<void>) {
  await page.route(QUEUE_URL, (route) => handler(route, new URL(route.request().url())));
}

function queueRequest(page: Page, predicate: (params: URLSearchParams) => boolean) {
  return page.waitForRequest(
    (request) => QUEUE_URL.test(request.url()) && predicate(new URL(request.url()).searchParams),
  );
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([fixtureCookie("manager")]);
  await page.route("**/fixture-receipt.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><rect width="120" height="160" fill="#fffdf7"/><g fill="#4c4c43" font-family="monospace"><text x="12" y="24" font-size="8">SVL TEST RECEIPT</text><text x="12" y="44" font-size="6">Materials / fixture</text><text x="12" y="67" font-size="6">2 x supplies  54.00</text><text x="12" y="85" font-size="6">1 x part      20.45</text><text x="12" y="121" font-size="8">TOTAL  128.45</text><text x="12" y="145" font-size="6">SYNTHETIC DATA</text></g></svg>',
    }),
  );
});

test("oldest-first inbox exposes history and status views and required row evidence", async ({
  page,
}) => {
  await routeQueue(page, (route) => fulfillQueue(route));
  const firstRequest = queueRequest(page, () => true);
  await page.goto("/");
  const initial = new URL((await firstRequest).url()).searchParams;
  expect(initial.get("sort") ?? "oldest").toBe("oldest");
  expect(initial.get("tab") ?? "needs-review").toBe("needs-review");
  await expect(page.getByRole("heading", { name: "Receipt inbox" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort receipts" })).toHaveValue("oldest");
  const tabs = page.getByRole("navigation", { name: "Receipt status" });
  await expect(tabs.getByRole("link")).toHaveText([
    "Needs review",
    "All history",
    "Processing",
    "Partial success",
    "Failed",
    "Completed",
    "Rejected / Duplicate",
  ]);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const evidence of [
    "Copperfield Supply",
    "INV-1042",
    "$128.45",
    "Worker a2700000",
    "#14 · Orchard House",
    "Low",
  ])
    await expect(rows.nth(0)).toContainText(evidence);
  await expect(rows.nth(1)).toContainText("Northgate Tools");
  for (const evidence of [
    "Vendor unavailable",
    "Total unavailable",
    "No suggestion yet",
    "Unavailable",
  ])
    await expect(rows.nth(2)).toContainText(evidence);
  await expect(rows.nth(0).getByRole("img", { name: "Receipt first page" })).toBeVisible();
  await expect(rows.nth(0).locator("time")).toHaveAttribute("datetime", RECEIPTS[0].submittedAt);
  await expect(
    rows.nth(0).getByRole("button", { name: /warnings for Copperfield Supply/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("manager-desktop.png"), fullPage: true });
});

test("all queue tabs navigate with their status and history navigation works", async ({ page }) => {
  await routeQueue(page, (route) => fulfillQueue(route));
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Receipt status" });
  for (const [label, tab] of [
    ["Processing", "processing"],
    ["Partial success", "partial-success"],
    ["Failed", "failed"],
    ["Completed", "completed"],
    ["Rejected / Duplicate", "rejected-duplicate"],
    ["Needs review", "needs-review"],
  ]) {
    const requested = queueRequest(page, (params) => (params.get("tab") ?? "needs-review") === tab);
    await tabs.getByRole("link", { name: label, exact: true }).click();
    await requested;
    await expect(tabs.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(page.getByRole("heading", { name: "Receipt history" })).toBeVisible();
  await expect(page).toHaveURL(/tab=history/);
});

test("filters, search, sort and page size are submitted and clear the cursor", async ({ page }) => {
  await routeQueue(page, (route) => fulfillQueue(route, RECEIPTS, "fixture-page-2"));
  await page.goto("/?cursor=fixture-page-2");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Review / export state" }).selectOption("needs_review");
  await page.getByRole("combobox", { name: "Receipt age", exact: true }).selectOption("over-24h");
  await page.getByRole("combobox", { name: /^Submitter/ }).selectOption(FIXTURE_USERS.worker.id);
  await page.getByLabel("Vendor", { exact: true }).fill("Copperfield");
  await page.getByRole("combobox", { name: "Field confidence", exact: true }).selectOption("low");
  await page
    .getByRole("combobox", { name: "Duplicate flag", exact: true })
    .selectOption("unmarked");
  await page
    .getByRole("combobox", { name: "Housecall status", exact: true })
    .selectOption("not_started");
  await page.getByLabel("Submitted from (UTC)").fill("2026-08-01");
  await page.getByLabel("Submitted to (UTC)").fill("2026-09-06");
  const appliedRequest = queueRequest(page, (params) => params.get("vendor") === "Copperfield");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const applied = new URL((await appliedRequest).url()).searchParams;
  for (const [key, value] of Object.entries({
    status: "needs_review",
    age: "over-24h",
    submitter: FIXTURE_USERS.worker.id,
    vendor: "Copperfield",
    confidence: "low",
    duplicate: "unmarked",
    housecall: "not_started",
    from: "2026-08-01",
    to: "2026-09-06",
  }))
    expect(applied.get(key)).toBe(value);
  expect(applied.has("cursor")).toBe(false);
  await expect(page).not.toHaveURL(/cursor=/);
  await page
    .getByRole("textbox", { name: "Search vendor, reference, or receipt ID" })
    .fill("INV-1042");
  const searched = queueRequest(page, (params) => params.get("search") === "INV-1042");
  await page.getByRole("button", { name: "Search receipts" }).click();
  await searched;
  const sorted = queueRequest(page, (params) => params.get("sort") === "newest");
  await page.getByRole("combobox", { name: "Sort receipts" }).selectOption("newest");
  await sorted;
  const resized = queueRequest(page, (params) => params.get("limit") === "50");
  await page.getByRole("combobox", { name: "Receipts per page" }).selectOption("50");
  await resized;
  const cleared = queueRequest(page, (params) => !params.has("vendor") && !params.has("search"));
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  const afterClear = new URL((await cleared).url()).searchParams;
  expect(afterClear.get("sort")).toBe("newest");
  expect(afterClear.get("limit")).toBe("50");
  expect(afterClear.has("cursor")).toBe(false);
  await expect(
    page.getByRole("textbox", { name: "Search vendor, reference, or receipt ID" }),
  ).toHaveValue("");
});

test("pagination supports next, previous, first page, and browser back", async ({ page }) => {
  await routeQueue(page, (route, url) =>
    fulfillQueue(
      route,
      url.searchParams.has("cursor") ? [RECEIPTS[1]] : [RECEIPTS[0]],
      url.searchParams.has("cursor") ? null : "fixture-page-2",
    ),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Northgate Tools", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Northgate Tools", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "First page", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
});

test("an emptied later page returns to the queue without claiming every receipt is reviewed", async ({
  page,
}) => {
  await routeQueue(page, (route, url) =>
    fulfillQueue(
      route,
      url.searchParams.has("cursor") ? [] : [RECEIPTS[0]],
      url.searchParams.has("cursor") ? null : "fixture-page-2",
    ),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No more receipts on this page" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You’re all caught up" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to first page", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
});

test("loading, initial failure and retry lead to a clear empty state", async ({ page }) => {
  const pending = deferred();
  let fail = true;
  await routeQueue(page, async (route) => {
    if (fail) {
      await pending.promise;
      await route.fulfill({ status: 503, json: { error: { code: "internal" } } });
    } else await fulfillQueue(route, []);
  });
  await page.goto("/");
  await expect(page.locator('[aria-live="polite"]')).toHaveText("Loading receipts");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  pending.resolve();
  await expect(page.getByRole("heading", { name: "Queue unavailable" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You’re all caught up" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("browser back followed by Previous follows the visible page cursor", async ({ page }) => {
  await routeQueue(page, (route, url) => {
    const cursor = url.searchParams.get("cursor");
    if (cursor === "fixture-page-3") return fulfillQueue(route, [RECEIPTS[2]], null);
    if (cursor === "fixture-page-2") return fulfillQueue(route, [RECEIPTS[1]], "fixture-page-3");
    return fulfillQueue(route, [RECEIPTS[0]], "fixture-page-2");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Northgate Tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Vendor unavailable", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Northgate Tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/cursor=/);
});

test("thumbnail failures leave the receipt usable and refresh retries the image", async ({
  page,
}) => {
  let thumbnailRequests = 0;
  let fail = true;
  await page.route("**/fixture-receipt.svg", async (route) => {
    thumbnailRequests += 1;
    if (fail) await route.fulfill({ status: 503, body: "Unavailable" });
    else
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="38" height="48"><rect width="38" height="48" fill="white"/></svg>',
      });
  });
  await routeQueue(page, (route) => fulfillQueue(route, [RECEIPTS[0]]));
  await page.goto("/");
  await expect.poll(() => thumbnailRequests).toBeGreaterThan(0);
  await expect(page.locator("tbody").getByRole("img", { name: "Receipt first page" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  const beforeRefresh = thumbnailRequests;
  fail = false;
  await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  await expect.poll(() => thumbnailRequests).toBeGreaterThan(beforeRefresh);
  await expect(
    page.locator("tbody").getByRole("img", { name: "Receipt first page" }),
  ).toBeVisible();
});

test("filtered empty results and invalid filters have working reset actions", async ({ page }) => {
  await routeQueue(page, async (route, url) => {
    if (url.searchParams.get("vendor") === "bad") {
      await route.fulfill({ status: 400, json: { error: { code: "invalid_request" } } });
    } else await fulfillQueue(route, url.searchParams.has("search") ? [] : RECEIPTS);
  });
  await page.goto("/?search=unmatched");
  await expect(
    page.getByRole("heading", { name: "No receipts match these filters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.goto("/?vendor=bad");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "These queue filters could not be used",
  );
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
});

test("a failed refresh keeps stale rows and a retry restores fresh data", async ({ page }) => {
  let fail = false;
  await routeQueue(page, async (route) => {
    if (fail) await route.abort("failed");
    else await fulfillQueue(route);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Showing the last loaded results",
  );
  await expect(page.getByText("May be out of date", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Updated just now", { exact: true })).toBeVisible();
});

test("ageing results announce that the queue needs refreshing", async ({ page }) => {
  await page.clock.install();
  await routeQueue(page, (route) => fulfillQueue(route));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  await page.clock.fastForward(151_000);
  await expect(page.getByRole("status")).toContainText("loaded over two minutes ago");
  await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  await expect(page.getByText("Updated just now", { exact: true })).toBeVisible();
});

test("a superseded request cannot replace a newer search result", async ({ page }) => {
  const slowStarted = deferred();
  const releaseSlow = deferred();
  const slowFinished = deferred();
  await routeQueue(page, async (route, url) => {
    if (url.searchParams.get("search") === "slow") {
      slowStarted.resolve();
      await releaseSlow.promise;
      try {
        await fulfillQueue(route, [{ ...RECEIPTS[0], vendor: "Outdated slow result" }]);
      } finally {
        slowFinished.resolve();
      }
    } else if (url.searchParams.get("search") === "fast") {
      await fulfillQueue(route, [{ ...RECEIPTS[1], vendor: "Current fast result" }]);
    } else await fulfillQueue(route);
  });
  await page.goto("/");
  const search = page.getByRole("textbox", { name: "Search vendor, reference, or receipt ID" });
  await search.fill("slow");
  await page.getByRole("button", { name: "Search receipts" }).click();
  await slowStarted.promise;
  await search.fill("fast");
  await page.getByRole("button", { name: "Search receipts" }).click();
  await expect(
    page.getByRole("button", { name: "Current fast result", exact: true }),
  ).toBeVisible();
  releaseSlow.resolve();
  await slowFinished.promise;
  await expect(
    page.getByRole("button", { name: "Current fast result", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Outdated slow result", exact: true })).toHaveCount(
    0,
  );
});

test("receipt summaries open by keyboard, contain evidence, and remain read only", async ({
  page,
}) => {
  await routeQueue(page, (route) => fulfillQueue(route));
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Open receipt summary for Copperfield Supply" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Copperfield Supply" });
  await expect(dialog).toBeVisible();
  for (const evidence of [
    "$128.45",
    "2 pages",
    "Low extraction confidence",
    "read-only queue summary",
  ])
    await expect(dialog).toContainText(evidence);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /approve|send|save|decline/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: /warnings for Copperfield Supply/ }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Back to queue" }).click();
  await expect(dialog).not.toBeVisible();
});

test("session expiry or revoked access removes previously loaded receipts", async ({ page }) => {
  let responseStatus = 200;
  await routeQueue(page, async (route) => {
    if (responseStatus === 200) await fulfillQueue(route);
    else
      await route.fulfill({ status: responseStatus, json: { error: { code: "unauthenticated" } } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  responseStatus = 401;
  await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
    "href",
    "/login",
  );
  responseStatus = 403;
  await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Manager access required" })).toBeVisible();
  responseStatus = 200;
  await page.getByRole("button", { name: "Check access again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
});

test("real server auth admits managers and admins and protects settings", async ({
  page,
  context,
}) => {
  // No queue interception: real route -> requireManager -> fixture HTTP -> empty RPC response.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Receipt inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  const managerResponse = await page.request.get("/api/manager/queue");
  expect(managerResponse.status()).toBe(200);
  expect(managerResponse.headers()["cache-control"]).toContain("no-store");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/$/);
  await context.clearCookies();
  await context.addCookies([fixtureCookie("admin")]);
  await page.goto("/");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
  expect((await page.request.get("/api/manager/queue")).status()).toBe(200);
});

test("real server auth denies workers, disabled users and anonymous requests", async ({
  page,
  context,
}) => {
  // Browser fixtures never intercept these calls: these exercise the application guards.
  await context.clearCookies();
  await context.addCookies([fixtureCookie("worker")]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Manager access required" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Receipt status" })).toHaveCount(0);
  const workerResponse = await page.request.get("/api/manager/queue");
  expect(workerResponse.status()).toBe(403);
  expect((await workerResponse.json()).error.code).toBe("forbidden");
  const bearerResponse = await page.request.get("/api/manager/queue", {
    headers: { authorization: `Bearer ${fixtureSession("worker").access_token}` },
  });
  expect(bearerResponse.status()).toBe(403);
  await context.clearCookies();
  await context.addCookies([fixtureCookie("disabled")]);
  const disabledResponse = await page.request.get("/api/manager/queue");
  expect(disabledResponse.status()).toBe(401);
  expect((await disabledResponse.json()).error.code).toBe("account_inactive");
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await context.clearCookies();
  expect((await page.request.get("/api/manager/queue")).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("narrow screens keep navigation, filtering and receipt summary usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeQueue(page, (route) => fulfillQueue(route));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copperfield Supply", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("manager-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByLabel("Vendor", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "Open receipt summary for Copperfield Supply" }).click();
  await expect(page.getByRole("dialog", { name: "Copperfield Supply" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Close receipt summary" }).click();
});
