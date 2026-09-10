import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(process.env.RA6_LOCAL_BROWSER !== "1", "Explicit local review acceptance only");
type State = { email: string; password: string; receipts: Record<string, string> };
let state: State;
let customer2JobId: string;
let customer3JobId: string;
test.beforeEach(async ({ page }) => {
  state = JSON.parse(await readFile(".local/ra6/local-review-state.json", "utf8"));
  const inventory = JSON.parse(await readFile(".local/ra6/test-jobs.json", "utf8")) as {
    jobs: Array<{ destinationKey: string; housecallJobId: string }>;
  };
  const jobId = (key: string) => {
    const job = inventory.jobs.find((row) => row.destinationKey === key);
    if (!job) throw new Error("Missing private test-job binding");
    return job.housecallJobId;
  };
  customer2JobId = jobId("test-customer-2");
  customer3JobId = jobId("test-customer-3");
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return ["http://127.0.0.1:3196", "http://127.0.0.1:55321"].includes(origin)
      ? route.continue()
      : route.abort();
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Receipt inbox\.?$/ })).toBeVisible();
});

test("correct supplier/date, approve locally, and inspect the frozen disabled export", async ({
  page,
}) => {
  const receiptId = state.receipts["select-fractional-base"];
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByRole("heading", { name: "Receipt details", exact: true })).toBeVisible();
  const detailResponse = await page.request.get(`/api/manager/receipts/${receiptId}`);
  expect(detailResponse.ok()).toBe(true);
  const before = await detailResponse.json();
  if (before.editable) {
    await expect(page.getByRole("img", { name: "Original submitted receipt" })).toBeVisible();
    await page.getByLabel("Vendor *", { exact: true }).fill("RA6 Test Stone Supplier");
    await page.getByLabel("Purchase date *", { exact: true }).fill("2026-09-01");
    await page.getByLabel("Category *", { exact: true }).selectOption("ra6-materials");
    await page.getByLabel("Housecall job", { exact: true }).selectOption(customer2JobId);
    await page
      .getByLabel("Manager notes", { exact: true })
      .fill(
        "SYNTHETIC RA6 TEST: supplier corrected against the visible image; numeric date confirmed as September 1, 2026 from fixture manifest. Local review only; Housecall writes require separate explicit user approval.",
      );
    await expect(page.getByRole("status", { name: "Material 1 extended cost" })).toHaveText(
      "$21.00",
    );
    await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(customer2JobId);
    await page.screenshot({
      path: ".local/ra6/browser-results/select-approval-preview.png",
      fullPage: true,
    });
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Approve receipt", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel("Vendor *", { exact: true })).toBeDisabled();
  }
  const previewResponse = await page.request.get(
    `/api/manager/receipts/${receiptId}/export-preview`,
  );
  expect(previewResponse.ok()).toBe(true);
  const preview = await previewResponse.json();
  expect(preview.liveWritesEnabled).toBe(false);
  expect(preview.separateApprovalRequired).toBe(true);
  expect(preview.totalMaterialCostCents).toBe(2100);
  expect(preview.jobs).toHaveLength(1);
  expect(preview.jobs[0].id).toBe(customer2JobId);
  expect(preview.jobs[0].images).toHaveLength(1);
  expect(preview.jobs[0].lines).toHaveLength(1);
  expect(preview.jobs[0].lines[0]).toMatchObject({
    qty: 0.5,
    unitCostCents: 4200,
    extendedCostCents: 2100,
    status: "ready",
    externalId: null,
  });
  expect(preview.blockedReasons).toContain("live_writes_disabled");
  expect(preview.blockedReasons).toContain("destination_not_approved");
  await writeFile(".local/ra6/first-export-preview.json", `${JSON.stringify(preview, null, 2)}\n`, {
    mode: 0o600,
  });
  const region = page.getByRole("region", { name: "Housecall export preview" });
  await region.getByRole("button", { name: "Load export preview", exact: true }).click();
  await expect(region).toContainText("$21.00");
  await region.scrollIntoViewIfNeeded();
  await region.screenshot({ path: ".local/ra6/browser-results/select-frozen-export.png" });
});

test("keep all six consolidated lines in review when three destinations remain unresolved", async ({
  page,
}) => {
  const receiptId = state.receipts["sandman-shop-and-missing-job"];
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByRole("heading", { name: "Receipt details", exact: true })).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveCount(6);
  await page.getByLabel("Purchase date *", { exact: true }).fill("2026-09-04");
  await page.getByLabel("Category *", { exact: true }).selectOption("ra6-materials");
  const jobs = page.getByLabel("Housecall job", { exact: true });
  await jobs.nth(1).selectOption(customer2JobId);
  await jobs.nth(2).selectOption(customer2JobId);
  await jobs.nth(3).selectOption(customer3JobId);
  for (const index of [0, 4, 5]) await jobs.nth(index).selectOption("");
  await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const preview = await (
    await page.request.get(`/api/manager/receipts/${receiptId}/export-preview`)
  ).json();
  expect(preview.intentId).toBeNull();
  expect(preview.jobs).toHaveLength(0);
  await expect(page.getByLabel("Description", { exact: true })).toHaveCount(6);
  await page.screenshot({
    path: ".local/ra6/browser-results/consolidated-unresolved.png",
    fullPage: true,
  });
});
