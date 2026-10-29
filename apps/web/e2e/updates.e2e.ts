import { expect, test } from "@playwright/test";
import { fixtureCookie } from "./fixture-auth.mjs";

for (const role of ["manager", "admin"] as const) {
  test(`${role} can open Updates from the sidebar without a duplicate History link`, async ({
    page,
    context,
  }) => {
    await context.addCookies([fixtureCookie(role)]);
    await page.goto("/");
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation.getByRole("link", { name: "History", exact: true })).toHaveCount(0);
    await navigation.getByRole("link", { name: "Updates", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/updates");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Updates", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByRole("link", { name: "Inbox", exact: true })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });
}

test("a worker is redirected from direct Updates access to their field workspace", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("worker")]);
  await page.goto("/updates");
  await expect(page).toHaveURL((url) => url.pathname === "/field");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
});

test("signed-out visitors must sign in before Updates is served", async ({ page }) => {
  await page.goto("/updates");
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === "/updates",
  );
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
});
