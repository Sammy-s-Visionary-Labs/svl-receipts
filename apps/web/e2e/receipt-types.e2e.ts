import { expect, test } from "@playwright/test";
import { fixtureCookie } from "./fixture-auth.mjs";

test("admin classification resumes bounded batches and reports saved types", async ({
  context,
  page,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  const cutoff = "2026-10-27T12:00:00Z";
  let batches = 0;
  await page.route("**/api/admin/receipt-types", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          cutoff,
          total: 3,
          completed: 0,
          credit: 0,
          debit: 0,
          unknown: 0,
          remaining: 3,
          failed: 0,
        },
      });
    expect(route.request().postDataJSON()).toEqual({ cutoff });
    batches++;
    return route.fulfill({
      json: {
        cutoff,
        total: 3,
        completed: batches === 1 ? 2 : 3,
        credit: 1,
        debit: batches === 1 ? 1 : 2,
        unknown: 0,
        remaining: batches === 1 ? 1 : 0,
        failed: 0,
        claimed: batches === 1 ? 2 : 1,
      },
    });
  });
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Receipt Credit/Debit classification" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Classify existing receipts / Resume", exact: true })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "3 of 3 classified" })).toContainText(
    "1 Credit · 2 Debit · 0 Review required · 0 Failed",
  );
  expect(batches).toBe(2);
  await expect(
    page.getByRole("button", { name: "Classify existing receipts / Resume", exact: true }),
  ).toBeDisabled();
});
