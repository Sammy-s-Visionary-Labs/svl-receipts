import { expect, test } from "@playwright/test";
import { fixtureCookie } from "./fixture-auth.mjs";

const worker = {
  id: "91000000-0000-4000-8000-000000000001",
  full_name: "Test Worker",
  email: "test@example.invalid",
  phone: "555-0100",
  role: "worker",
  disabled: true,
  access_status: "pending",
  access_version: 0,
  created_at: "2026-09-16T12:00:00Z",
};

test("first-time worker requests access from a dedicated mobile sign-in page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let submitted: unknown = null;
  await page.route("**/api/access-requests", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      json: { message: "Your request has been sent to the manager." },
    });
  });
  await page.goto("/worker-login");
  await expect(page.getByRole("heading", { name: "Worker sign in" })).toBeVisible();
  await page.getByRole("link", { name: "Request worker access" }).click();
  await page.getByLabel("Full name").fill("Test Worker");
  await page.getByLabel("Email", { exact: true }).fill("test@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("test-password-only");
  await page.getByLabel("Confirm password").fill("test-password-only");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("sent to the manager");
  expect(submitted).toEqual({
    fullName: "Test Worker",
    email: "test@example.invalid",
    phone: "",
    password: "test-password-only",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("manager approves requests and disables workers without role controls", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("manager")]);
  let account = { ...worker };
  const changes: unknown[] = [];
  await page.route("**/api/manager/users**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      changes.push(body);
      if (body.action === "approve")
        account = { ...account, access_status: "approved", disabled: false, access_version: 1 };
      if (body.action === "disable") account = { ...account, disabled: true, access_version: 2 };
      return route.fulfill({ json: { ok: true } });
    }
    const matches =
      new URL(route.request().url()).searchParams.get("status") === account.access_status;
    return route.fulfill({ json: { users: matches ? [account] : [], total: matches ? 1 : 0 } });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Access updated" })).toContainText(
    "Access updated",
  );
  await page.getByRole("combobox", { name: "Show", exact: true }).selectOption("approved");
  await expect(page.getByText("worker · Active", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Role for Test Worker", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Disable account" }).click();
  await expect(page.getByRole("button", { name: "Enable account" })).toBeVisible();
  expect(changes).toEqual([
    { userId: worker.id, action: "approve", version: 0 },
    { userId: worker.id, action: "disable", version: 1 },
  ]);
});

test("administrator changes a worker's role with the current account version", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  let account = { ...worker, access_status: "approved", disabled: false };
  let changed: unknown = null;
  await page.route("**/api/manager/users**", async (route) => {
    if (route.request().method() === "POST") {
      changed = route.request().postDataJSON();
      account = { ...account, role: "manager", access_version: 1 };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { users: [account], total: 1 } });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/team");
  await page.getByRole("combobox", { name: "Show", exact: true }).selectOption("approved");
  await page
    .getByRole("combobox", { name: "Role for Test Worker", exact: true })
    .selectOption("manager");
  await expect(page.getByRole("status").filter({ hasText: "Access updated" })).toContainText(
    "Access updated",
  );
  expect(changed).toEqual({ userId: worker.id, action: "role", role: "manager", version: 0 });
});

test("workers cannot open team management or its API", async ({ page, context }) => {
  await context.addCookies([fixtureCookie("worker")]);
  await page.goto("/team");
  await expect(page).toHaveURL(/\/field$/);
  expect((await page.request.get("/api/manager/users")).status()).toBe(403);
});
