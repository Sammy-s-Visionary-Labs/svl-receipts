import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { FIXTURE_USERS, fixtureCookie, fixtureSession } from "./fixture-auth.mjs";

const fixtureOrigin = `http://127.0.0.1:${process.env.RA27_E2E_AUTH_PORT ?? 54877}`;
async function photo() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1400"><rect width="900" height="1400" fill="white"/><g fill="#22352b" font-family="sans-serif" font-size="45"><text x="100" y="150">SVL TEST RECEIPT</text><text x="100" y="280">September 15, 2026</text><text x="100" y="430">Materials</text><text x="100" y="800">TOTAL $84.50</text><text x="100" y="1000">SYNTHETIC TEST DATA</text></g></svg>';
  return {
    name: "receipt.png",
    mimeType: "image/png",
    buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
  };
}
test.beforeEach(async ({ context, request }) => {
  await request.post(`${fixtureOrigin}/__field/reset`);
  await context.addCookies([fixtureCookie("worker")]);
});
test.afterEach(async ({ request }) => {
  await request.post(`${fixtureOrigin}/__field/reset`);
});

test("worker enters the field workspace; manager dashboard and bearer guards stay intact", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL((url) => url.pathname === "/field");
  await expect(page.getByRole("heading", { name: "Good work. Less paperwork." })).toBeVisible();
  expect((await page.request.get("/api/manager/queue")).status()).toBe(403);
  expect(
    (
      await page.request.get("/api/me", {
        headers: { authorization: `Bearer ${fixtureSession("worker").access_token}` },
      })
    ).status(),
  ).toBe(200);
  await context.clearCookies();
  await context.addCookies([fixtureCookie("manager")]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Receipt inbox" })).toBeVisible();
  await context.clearCookies();
  await page.goto("/field/new");
  await expect(page).toHaveURL(/\/worker-login\?next=/);
});

test("full browser upload uses real session, signed storage, checksum confirmation, history and manager APIs", async ({
  page,
  context,
}) => {
  await page.goto("/field/new");
  await page.getByLabel("Choose receipt photos").setInputFiles([await photo(), await photo()]);
  await expect(page.getByRole("img", { name: "Receipt page preview" })).toHaveCount(2);
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send to office", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toBeVisible();
  const state = await (await page.request.get(`${fixtureOrigin}/__field/state`)).json();
  expect(state.receipts).toHaveLength(1);
  expect(state.receipts[0].owner_user_id).toBe(FIXTURE_USERS.worker.id);
  expect(state.pages).toHaveLength(2);
  expect(state.objectCount).toBe(2);
  expect(
    state.pages.every((item: { checksum: string }) => /^[a-f0-9]{64}$/.test(item.checksum)),
  ).toBe(true);
  const history = await (await page.request.get("/api/me/receipts")).json();
  expect(history.receipts[0].id).toBe(state.receipts[0].id);
  expect(history.receipts[0].pageCount).toBe(2);
  const nativeDetail = await page.request.get(`/api/me/receipts/${state.receipts[0].id}`, {
    headers: { authorization: `Bearer ${fixtureSession("worker").access_token}` },
  });
  expect(nativeDetail.status()).toBe(200);
  expect((await nativeDetail.json()).pages).toHaveLength(2);
  await page.getByRole("link", { name: "Track this receipt" }).click();
  await expect(page.getByRole("img", { name: "Receipt page 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.getByRole("img", { name: "Receipt page 2", exact: true })).toBeVisible();
  await context.clearCookies();
  await context.addCookies([fixtureCookie("manager")]);
  const queue = await (await page.request.get("/api/manager/queue?tab=history")).json();
  expect(queue.receipts[0].id).toBe(state.receipts[0].id);
});

test("draft survives reload, supports rotation/removal, and is hidden from a different account", async ({
  page,
  context,
}) => {
  await page.goto("/field/new");
  await page.getByLabel("Choose receipt photos").setInputFiles([await photo(), await photo()]);
  await expect(page.getByRole("img", { name: "Receipt page preview" })).toHaveCount(2);
  await page.getByRole("button", { name: "Remove page 2" }).click();
  await page.getByRole("button", { name: "Rotate page 1" }).click();
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: "Receipt page preview" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send to office" })).toBeEnabled();
  const draftUrl = page.url();
  await context.clearCookies();
  await context.addCookies([fixtureCookie("manager")]);
  await page.goto(draftUrl);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "not available for your account",
  );
  await expect(page.getByRole("img", { name: "Receipt page preview" })).toHaveCount(0);
});

test("lost confirmation acknowledgement retries the same receipt without new uploads", async ({
  page,
}) => {
  await page.goto("/field/new");
  await page.getByLabel("Choose receipt photos").setInputFiles(await photo());
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  let first = true;
  await page.route("**/api/receipts/*/confirm", async (route) => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Send to office" }).click();
  await expect(page.getByRole("button", { name: "Retry sending" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Retry sending" }).click();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toBeVisible();
  const state = await (await page.request.get(`${fixtureOrigin}/__field/state`)).json();
  expect(state.receipts).toHaveLength(1);
  expect(state.objectCount).toBe(1);
});

test("offline capture stays a draft and reconnecting sends it", async ({ page, context }) => {
  await page.goto("/field/new");
  await page.getByLabel("Choose receipt photos").setInputFiles(await photo());
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Send to office" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Your draft is saved");
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Send to office" }).click();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toBeVisible();
});

test("phone layout, capture controls and public install manifest", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/field");
  await expect(page.getByRole("navigation", { name: "Field navigation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add a receipt", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/field-overview-phone.png", fullPage: true });
  await page.getByRole("link", { name: "New receipt", exact: true }).click();
  await expect(page.getByLabel("Take receipt photo")).toHaveAttribute("capture", "environment");
  await expect(page.getByRole("button", { name: "Take a photo", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/field-capture-phone.png", fullPage: true });
  await context.clearCookies();
  const manifest = await page.request.get("/field/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).start_url).toBe("/field");
  expect((await page.request.get("/field/icon-192.png")).status()).toBe(200);
});

test("retake guidance, pagination, and expired sessions are handled in history", async ({
  page,
}) => {
  const id = "b3700000-0000-4000-8000-000000000002";
  let expired = false;
  await page.route("**/api/me/receipts*", async (route) => {
    if (expired)
      return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } });
    const older = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      json: {
        receipts: [
          {
            id: older ? "b3700000-0000-4000-8000-000000000003" : id,
            workerStatus: older ? "approved" : "needs_retake",
            status: older ? "approved" : "rejected_unreadable",
            submittedAt: "2026-09-15T10:00:00Z",
            pageCount: 1,
            thumbnail: null,
          },
        ],
        nextCursor: older ? null : "older-page",
      },
    });
  });
  await page.goto("/field/receipts");
  await expect(page.getByText("Needs retake", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Load older receipts" }).click();
  await expect(page.getByRole("link", { name: /Receipt ·/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Approved", exact: true }).click();
  await expect(page.getByRole("link", { name: /Receipt ·/ })).toHaveCount(1);
  expired = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("link", { name: /Receipt ·/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
});

test("password sign-in and sign-out preserve the owner's unsent draft", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/login?next=/field");
  await page.getByLabel("Email", { exact: true }).fill("worker@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/field");
  await page.getByRole("link", { name: "New receipt", exact: true }).click();
  await page.getByLabel("Choose receipt photos").setInputFiles(await photo());
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Sign out and keep drafts" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email", { exact: true }).fill("worker@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("link", { name: /Receipt draft/ })).toBeVisible();
});

test("a stale tab cannot alter or resend a completed draft", async ({ page, context }) => {
  await page.goto("/field/new");
  await page.getByLabel("Choose receipt photos").setInputFiles(await photo());
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto(page.url());
  await expect(otherTab.getByRole("img", { name: "Receipt page preview" })).toBeVisible();
  await page.getByRole("button", { name: "Send to office", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toBeVisible();
  await otherTab.getByRole("button", { name: "Send to office", exact: true }).click();
  await expect(otherTab.getByRole("main").getByRole("alert")).toContainText(
    "changed in another tab",
  );
  const state = await (await page.request.get(`${fixtureOrigin}/__field/state`)).json();
  expect(state.receipts).toHaveLength(1);
  await otherTab.close();
});

test("receipt detail shows office notes and specific retake guidance", async ({ page }) => {
  const id = "b3700000-0000-4000-8000-000000000004";
  await page.route(`**/api/me/receipts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        workerStatus: "needs_retake",
        submittedAt: "2026-09-15T10:00:00Z",
        pages: [],
        clarification: "Please include the total at the bottom.",
        readability: {
          readable: false,
          failedPageIndexes: [0],
          reasons: [{ code: "blur", guidance: "Hold the camera steady and take a sharper photo." }],
        },
      },
    }),
  );
  await page.goto(`/field/receipts/${id}`);
  await expect(page.getByText("Please include the total at the bottom.")).toBeVisible();
  await expect(page.getByText("Hold the camera steady and take a sharper photo.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Retake receipt" })).toHaveAttribute(
    "href",
    "/field/new",
  );
});

test("a false browser offline hint does not block a reachable receipt service", async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false }));
  await page.goto("/field/new");
  await expect(page.getByRole("banner")).toContainText("Connected");
  await page.getByLabel("Choose receipt photos").setInputFiles(await photo());
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send to office", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your receipt is sent." })).toBeVisible();
});
