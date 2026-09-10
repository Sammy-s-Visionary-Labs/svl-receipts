import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(process.env.RA6_FINAL_LOCAL_REVIEW !== "1", "Opt-in isolated local review only");
test("freeze supported two-page allocation and verify manual closure display", async ({ page }) => {
  const state = JSON.parse(await readFile(".local/ra6/local-review-state.json", "utf8"));
  const approval = JSON.parse(
    await readFile(".local/ra6/test-customer-authorization.json", "utf8"),
  );
  const job = (key: string) =>
    approval.bindings.find((b: { destinationKey: string }) => b.destinationKey === key).jobId;
  await page.route("**/*", (route) =>
    ["http://127.0.0.1:3196", "http://127.0.0.1:55321"].includes(
      new URL(route.request().url()).origin,
    )
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Receipt inbox\.?$/ })).toBeVisible();
  await page.goto(`/receipts/${state.receipts["half-up-two-pages"]}`);
  const region = page.getByRole("region", { name: "Housecall export preview" });
  await region.getByRole("button", { name: "Load export preview", exact: true }).click();
  await expect(region).toContainText("Automatic export stopped for manual handling.");
  await expect(region).not.toContainText("Approve the receipt to freeze its export plan.");
  await page.screenshot({
    path: ".local/ra6/expanded-browser-results/manual-handoff.png",
    fullPage: true,
  });
  const receiptId = state.receipts["perrysburg-supported-two-pages"];
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByRole("heading", { name: "Receipt details", exact: true })).toBeVisible();
  const detail = await (await page.request.get(`/api/manager/receipts/${receiptId}`)).json();
  if (detail.editable) {
    await page.getByLabel("Category *", { exact: true }).selectOption("ra6-materials");
    for (const [index, qty] of [4, 2, 1].entries()) {
      await expect(page.getByLabel("Quantity", { exact: true }).nth(index)).toHaveValue(
        String(qty),
      );
      await page
        .getByLabel("Housecall job", { exact: true })
        .nth(index)
        .selectOption(job(index === 2 ? "test-customer-4" : "test-customer-3"));
    }
    await page
      .getByLabel("Manager notes", { exact: true })
      .fill(
        "SYNTHETIC RA-6 supported-quantity acceptance. Retained Gemini regression result checked against the two simulated Perrysburg pages. Oak Demo is a fixture alias only. Controlled manual split: pipe and elbow to Test Customer#3; cement to Test Customer#4. Send both pages to both exact verified test jobs; exclude $5.62 tax. No business customer lookup.",
      );
    await page.getByRole("button", { name: "Approve receipt", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Approve receipt", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  const response = await page.request.get(`/api/manager/receipts/${receiptId}/export-preview`);
  expect(response.ok()).toBe(true);
  const preview = await response.json();
  expect(preview.intentId).toBeTruthy();
  expect(preview.totalMaterialCostCents).toBe(7250);
  expect(preview.liveWritesEnabled).toBe(false);
  expect(preview.jobs).toHaveLength(2);
  expect(preview.jobs.every((j: { images: unknown[] }) => j.images.length === 2)).toBe(true);
  expect(preview.blockedReasons).not.toContain("unsupported_quantity_precision");
  await writeFile(
    ".local/ra6/perrysburg-supported-two-pages-preview.json",
    `${JSON.stringify(preview, null, 2)}\n`,
    { mode: 0o600 },
  );
  await page.getByRole("button", { name: "Load export preview", exact: true }).click();
  await page.screenshot({
    path: ".local/ra6/expanded-browser-results/supported-multipage-preview.png",
    fullPage: true,
  });
});
