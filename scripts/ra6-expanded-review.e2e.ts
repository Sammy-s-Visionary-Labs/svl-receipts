import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(process.env.RA6_EXPANDED_LOCAL_REVIEW !== "1", "Opt-in isolated local review");

test("show the precision block on the retained fractional receipt", async ({ page }) => {
  const state = JSON.parse(await readFile(".local/ra6/local-review-state.json", "utf8"));
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
  const receiptId = state.receipts["half-up-two-pages"];
  await page.goto(`/receipts/${receiptId}`);
  const region = page.getByRole("region", { name: "Housecall export preview" });
  await region.getByRole("button", { name: "Load export preview", exact: true }).click();
  await expect(region).toContainText("Quantities with more than two decimal places are blocked");
  const preview = await (
    await page.request.get(`/api/manager/receipts/${receiptId}/export-preview`)
  ).json();
  expect(preview.blockedReasons).toContain("unsupported_quantity_precision");
  expect(
    preview.jobs
      .flatMap((job: { lines: Array<{ qty: number }> }) => job.lines)
      .map((line: { qty: number }) => line.qty)
      .sort((a: number, b: number) => a - b),
  ).toEqual([1.005, 10.125]);
  await page.screenshot({
    path: ".local/ra6/expanded-browser-results/precision-block.png",
    fullPage: true,
  });
});

for (const fixtureId of ["klumm-two-jobs", "half-up-two-pages", "sandman-handwritten"]) {
  test(`review and freeze ${fixtureId}`, async ({ page }) => {
    const state = JSON.parse(await readFile(".local/ra6/local-review-state.json", "utf8"));
    const approval = JSON.parse(
      await readFile(".local/ra6/test-customer-authorization.json", "utf8"),
    );
    const manifest = JSON.parse(await readFile("fixtures/ra6/manifest.json", "utf8"));
    const fixture = manifest.receipts.find((r: { id: string }) => r.id === fixtureId);
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
    const receiptId = state.receipts[fixtureId];
    await page.goto(`/receipts/${receiptId}`);
    await expect(page.getByRole("heading", { name: "Receipt details", exact: true })).toBeVisible();
    const detail = await (await page.request.get(`/api/manager/receipts/${receiptId}`)).json();
    if (detail.editable) {
      await page.getByLabel("Vendor *", { exact: true }).fill(fixture.syntheticVendor);
      await page.getByLabel("Purchase date *", { exact: true }).fill(fixture.purchaseDate);
      await page.getByLabel("Category *", { exact: true }).selectOption("ra6-materials");
      await expect(page.getByLabel("Description", { exact: true })).toHaveCount(
        fixture.lines.length,
      );
      for (const [index, line] of fixture.lines.entries()) {
        await expect(page.getByLabel("Description", { exact: true }).nth(index)).toHaveValue(
          line.description,
        );
        await expect(page.getByLabel("Quantity", { exact: true }).nth(index)).toHaveValue(
          String(line.qty),
        );
        const binding = approval.bindings.find(
          (b: { destinationKey: string }) => b.destinationKey === line.destinationKey,
        );
        await page
          .getByLabel("Housecall job", { exact: true })
          .nth(index)
          .selectOption(binding.jobId);
        await expect(
          page.getByRole("status", { name: `Material ${index + 1} extended cost` }),
        ).toHaveText(`$${(line.extendedCostCents / 100).toFixed(2)}`);
      }
      await page
        .getByLabel("Manager notes", { exact: true })
        .fill(
          "SYNTHETIC RA6 TEST: reviewed against the synthetic fixture manifest and retained extraction. User's standing authorization covers only verified test customers; dispatch remains separately fenced to frozen requests.",
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
    expect(preview.liveWritesEnabled).toBe(false);
    expect(preview.totalMaterialCostCents).toBe(fixture.expected.materialTotalCents);
    expect(preview.jobs.length).toBe(
      Object.keys(fixture.expected.destinationMaterialTotalsCents).length,
    );
    for (const job of preview.jobs) {
      const binding = approval.bindings.find((b: { jobId: string }) => b.jobId === job.id);
      expect(binding).toBeTruthy();
      expect(job.images.length).toBe(fixture.pageCount);
      expect(
        job.lines.reduce(
          (sum: number, line: { extendedCostCents: number }) => sum + line.extendedCostCents,
          0,
        ),
      ).toBe(fixture.expected.destinationMaterialTotalsCents[binding.destinationKey]);
    }
    await writeFile(
      `.local/ra6/${fixtureId}-preview.json`,
      `${JSON.stringify(preview, null, 2)}\n`,
      { mode: 0o600 },
    );
  });
}
