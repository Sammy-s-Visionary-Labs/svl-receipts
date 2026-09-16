import { expect, test } from "@playwright/test";
import { fixtureCookie } from "./fixture-auth.mjs";

const importId = "92100000-0000-4000-8000-000000000001";
test("administrator sees email source, retry guidance and aligned controls on desktop and phone", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  await page.route("**/api/manager/email-imports", (route) =>
    route.fulfill({
      json: {
        mailbox: "recisvl@gmail.com",
        configured: true,
        imports: [
          {
            id: importId,
            status: "needs_attention",
            subject: "TEST Sandman receipt",
            sender: "Test Vendor <vendor@example.invalid>",
            created_at: "2026-09-16T12:00:00Z",
            last_error: "invalid_or_locked_pdf",
            email_receipt_documents: [],
          },
        ],
      },
    }),
  );
  let retried = false;
  await page.route(`**/api/admin/email-imports/${importId}/retry`, (route) => {
    retried = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Email receipts" });
  await expect(panel.getByText("TEST Sandman receipt")).toBeVisible();
  await expect(
    panel.getByText("The PDF is damaged or password-protected. Send an unlocked copy."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Retry preparation" }).click();
  expect(retried).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(panel.getByRole("link", { name: "Original email" })).toHaveAttribute(
    "href",
    `/api/manager/email-imports/${importId}/original`,
  );
  await page.screenshot({ path: "../../test-results/email-settings-mobile.png", fullPage: true });
});
test("worker cannot read emailed sources or trigger an import through their account", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("worker")]);
  expect((await page.request.get("/api/manager/email-imports")).status()).toBe(403);
  expect((await page.request.get(`/api/manager/email-imports/${importId}/original`)).status()).toBe(
    403,
  );
  expect((await page.request.post(`/api/admin/email-imports/${importId}/retry`)).status()).toBe(
    403,
  );
  const result = await page.request.post("/api/email-imports", { data: { messageId: "test123" } });
  expect([401, 503]).toContain(result.status());
});
