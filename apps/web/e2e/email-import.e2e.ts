import { expect, test } from "@playwright/test";
import { fixtureCookie } from "./fixture-auth.mjs";

const importId = "92100000-0000-4000-8000-000000000001";
test("administrator sees email source, retry guidance and aligned controls on desktop and phone", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  let retried = false;
  await page.route("**/api/manager/email-imports", (route) =>
    route.fulfill({
      json: {
        mailbox: "recisvl@gmail.com",
        configured: true,
        lastContactAt: "2026-10-29T12:00:00Z",
        imports: [
          {
            id: importId,
            status: retried ? "queued" : "needs_attention",
            subject: "TEST Sandman receipt",
            sender: "Test Vendor <vendor@example.invalid>",
            created_at: "2026-09-16T12:00:00Z",
            last_error: retried ? null : "invalid_or_locked_pdf",
            email_receipt_documents: [],
          },
          ...["awaiting_upload", "queued", "processing", "imported"].map((status) => ({
            id: `test-${status}`,
            status,
            subject: `TEST ${status} email`,
            sender: "Test Vendor <vendor@example.invalid>",
            created_at: "2026-10-29T12:00:00Z",
            last_error: null,
            email_receipt_documents: [],
          })),
        ],
      },
    }),
  );
  await page.route(`**/api/admin/email-imports/${importId}/retry`, (route) => {
    retried = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Email receipts" });
  await expect(panel.getByText(/Last connected/)).toBeVisible();
  await expect(panel.getByText("TEST Sandman receipt")).toBeVisible();
  await expect(panel.getByText("TEST awaiting_upload email")).toBeVisible();
  await expect(panel.getByText("TEST queued email")).toBeVisible();
  await expect(panel.getByText("TEST processing email")).toBeVisible();
  await expect(panel.getByText("TEST imported email")).toHaveCount(0);
  await expect(panel.getByRole("listitem")).toHaveCount(4);
  await expect(
    panel.getByText("The PDF is damaged or password-protected. Send an unlocked copy."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Retry preparation" }).click();
  expect(retried).toBe(true);
  await expect(
    panel
      .getByRole("listitem")
      .filter({ hasText: "TEST Sandman receipt" })
      .getByText("Queued", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(
    panel
      .getByRole("listitem")
      .filter({ hasText: "TEST Sandman receipt" })
      .getByRole("link", { name: "Original email" }),
  ).toHaveAttribute("href", `/api/manager/email-imports/${importId}/original`);
  await page.screenshot({ path: "../../test-results/email-settings-mobile.png", fullPage: true });
});
test("email connection health remains visible with no pending or failed imports", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  await page.route("**/api/manager/email-imports", (route) =>
    route.fulfill({
      json: {
        configured: true,
        lastContactAt: "2026-10-29T12:00:00Z",
        imports: [],
      },
    }),
  );
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Email receipts" });
  await expect(panel.getByText(/Last connected/)).toBeVisible();
  await expect(panel.getByText("No pending or failed email imports.")).toBeVisible();
  await expect(panel.getByText(/Successfully imported receipts are available/)).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(panel.getByText("No emails received by the importer yet.")).toHaveCount(0);
});
test("email status list describes its fifty unresolved imports and ten-page PDF limit", async ({
  page,
  context,
}) => {
  await context.addCookies([fixtureCookie("admin")]);
  await page.route("**/api/manager/email-imports", (route) =>
    route.fulfill({
      json: {
        configured: true,
        lastContactAt: "2026-10-29T12:00:00Z",
        imports: Array.from({ length: 50 }, (_, index) => ({
          id: `test-pending-${index}`,
          status: index ? "queued" : "needs_attention",
          subject: `TEST pending email ${index}`,
          sender: "Test Vendor <vendor@example.invalid>",
          created_at: "2026-10-29T12:00:00Z",
          last_error: index ? null : "pdf_page_limit",
          email_receipt_documents: [],
        })),
      },
    }),
  );
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Email receipts" });
  await expect(panel.getByRole("listitem")).toHaveCount(50);
  await expect(
    panel.getByText("Showing the latest 50 pending or failed email imports."),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "This PDF exceeds the 10-page receipt limit. Split it into separate receipts and send it again.",
    ),
  ).toBeVisible();
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
