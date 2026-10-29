import { chmod, readFile, stat } from "node:fs/promises";
import {
  isApprovedReportResponse,
  MAX_REPORT_BYTES,
  monthIndex,
  monthLabel,
  REPORT_DOWNLOAD_ORIGIN,
  REPORT_URL,
  reportDateLabel,
  validateWorkbookBytes,
} from "./core.mjs";

// The picker briefly clears its selected range when the existing start is clicked.
const DATE_BUTTON =
  /^(?:[A-Z][a-z]{2} \d{1,2}, \d{4}(?: - [A-Z][a-z]{2} \d{1,2}, \d{4})?|Select date range)$/;
const DAILY_NOTE_OPTION = "Daily Timesheet Note Not associated with a job";

function reportFilterButton(panel, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return panel.getByRole("button", {
    name: new RegExp(`^(?:\\(\\d+\\)\\s*)?${escaped}(?:\\s|$)`),
  });
}

export class NeedsLoginError extends Error {}

export async function completeSourceConnection(page) {
  // Normal sign-in may return to the dashboard rather than the original report
  // URL. Wait for authenticated source UI, then reopen reports and verify it.
  try {
    await page
      .getByRole("tab", { name: "Timesheet Report", exact: true })
      .or(page.getByText("Sammy’s Visionary Landscape", { exact: true }))
      .first()
      .waitFor({ state: "visible", timeout: 600000 });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new NeedsLoginError(
        "Supercrew sign-in was not completed within 10 minutes; use Connect Supercrew to try again.",
        { cause: error },
      );
    }
    throw error;
  }
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await verifySignedIn(page);
}

export async function verifySignedIn(page) {
  try {
    await page
      .getByRole("tab", { name: "Timesheet Report", exact: true })
      .waitFor({ timeout: 20000 });
  } catch {
    throw new NeedsLoginError(
      "The Supercrew login needs attention. Run the isolated session setup and sign in normally.",
    );
  }
  if (new URL(page.url()).origin !== new URL(REPORT_URL).origin) {
    throw new NeedsLoginError(
      "Supercrew redirected to its login flow. Reconnect the isolated worker session.",
    );
  }
  if ((await page.getByText("Sammy’s Visionary Landscape", { exact: true }).count()) !== 1) {
    throw new NeedsLoginError(
      "The worker must be connected to Sammy’s Visionary Landscape in Supercrew. Check the source account before importing.",
    );
  }
}

export async function clearReportFilter(page, panel, name, placeholder) {
  const button = reportFilterButton(panel, name);
  await button.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor({ state: "visible" });
  if (placeholder) {
    let search = listbox.getByPlaceholder(placeholder, { exact: true });
    // Labels have varied in capitalization between reports. Clear the sole
    // listbox search before counting selected options hidden by that search.
    if (!(await search.count())) search = listbox.getByRole("textbox");
    if ((await search.count()) > 1)
      throw new Error(`The ${name} filter has an unrecognized search layout.`);
    if (await search.count()) await search.fill("");
  }
  // Source options contain duplicate job labels; clearing by selected DOM state
  // preserves all-job coverage without choosing a name/address destination.
  for (let attempts = 0; attempts < 300; attempts++) {
    const selected = listbox.locator('[role="option"][aria-selected="true"]');
    if ((await selected.count()) === 0) {
      await button.click();
      await listbox.waitFor({ state: "hidden" });
      return;
    }
    await selected.first().click();
  }
  throw new Error(
    `Could not clear the ${name} report filter. The Supercrew interface may have changed.`,
  );
}

async function selectCalendarDay(page, date) {
  const expectedMonth = monthLabel(date);
  const tooltip = page.getByRole("tooltip");
  for (let attempts = 0; attempts < 120; attempts++) {
    const grid = tooltip.getByRole("grid");
    const currentMonth = await grid.getAttribute("aria-labelledby").then(async (id) => {
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Unrecognized calendar month label.");
      return tooltip.locator(`[id="${id}"]`).innerText();
    });
    if (currentMonth === expectedMonth) {
      await tooltip
        .getByRole("grid", { name: expectedMonth, exact: true })
        .getByRole("gridcell", { name: String(Number(date.slice(8, 10))), exact: true })
        .click();
      return;
    }
    const direction = monthIndex(currentMonth) < monthIndex(expectedMonth) ? "next" : "previous";
    await tooltip.getByRole("button", { name: `Go to ${direction} month`, exact: true }).click();
  }
  throw new Error("The requested report date is outside the supported calendar navigation window.");
}

export async function setReportInterval(page, panel, interval) {
  const button = panel.getByRole("button", { name: DATE_BUTTON });
  const expected = reportDateLabel(interval);
  if ((await button.innerText()).trim() === expected) return;
  await button.click();
  const tooltip = page.getByRole("tooltip");
  await tooltip.getByRole("button", { name: "Custom", exact: true }).click();
  // Existing selected ranges can make the first click shorten/reset the range.
  // Check the visible label each time and stop only on the exact desired span.
  const sequence =
    interval.start === interval.end
      ? [interval.start, interval.start, interval.start]
      : [interval.end, interval.start, interval.end, interval.start];
  for (const date of sequence) {
    await selectCalendarDay(page, date);
    if ((await button.innerText()).trim() === expected) {
      await button.click();
      await tooltip.waitFor({ state: "hidden" });
      return;
    }
  }
  throw new Error(
    "Supercrew did not select the exact requested report period. The workbook was not downloaded.",
  );
}

export async function prepareReport(page, interval) {
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await verifySignedIn(page);
  await page.getByRole("tab", { name: "Timesheet Report", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Timesheet Report", exact: true });
  await panel.getByRole("button", { name: "All Entries", exact: true }).click();
  await clearReportFilter(page, panel, "Job", "Find Job…");
  await clearReportFilter(page, panel, "Worker", "Find Worker…");
  await clearReportFilter(page, panel, "Time Entry Type");
  await setReportInterval(page, panel, interval);
  // Rendering a data table is source readiness evidence; it need not expose every
  // virtualized row because the full workbook, rather than the table, is imported.
  await panel.getByRole("table").waitFor({ timeout: 45000 });
  const download = await readyDownloadButton(page);
  return { panel, download };
}

async function readyDownloadButton(page) {
  const download = page.getByRole("button", { name: "Download Excel", exact: true });
  await download.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (el) => el.textContent.trim() === "Download Excel",
      );
      return Boolean(button && !button.disabled);
    },
    null,
    { timeout: 45000 },
  );
  return download;
}

export async function verifyDailyNoteFilter(page, panel) {
  const button = reportFilterButton(panel, "Note Type");
  await button.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor({ state: "visible" });
  const selected = listbox.locator('[role="option"][aria-selected="true"]');
  const daily = listbox.getByRole("option", { name: DAILY_NOTE_OPTION, exact: true });
  const verified =
    (await selected.count()) === 1 && (await daily.getAttribute("aria-selected")) === "true";
  await button.click();
  await listbox.waitFor({ state: "hidden" });
  if (!verified)
    throw new Error(
      "Supercrew did not retain the sole Daily Timesheet Note filter. Notes were not downloaded.",
    );
}

export async function verifyUnrestrictedNotesFilters(panel) {
  for (const name of ["Notetaker", "Notes For", "Job"]) {
    if ((await reportFilterButton(panel, name).innerText()).trim() !== name)
      throw new Error(
        `The Notes Report ${name} filter is restricted. Complete note coverage was not verified.`,
      );
  }
  if ((await panel.getByRole("textbox", { name: "Search...", exact: true }).inputValue()) !== "")
    throw new Error(
      "The Notes Report search is restricted. Complete note coverage was not verified.",
    );
}

export async function prepareNotesReport(page, interval) {
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await verifySignedIn(page);
  await page.getByRole("tab", { name: "Notes Report", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Notes Report", exact: true });
  // Daily note selection disables Job. Clear the type first, then all owner/job
  // restrictions so an empty export cannot silently mean missing worker coverage.
  await clearReportFilter(page, panel, "Note Type");
  await clearReportFilter(page, panel, "Notetaker", "Find worker…");
  await clearReportFilter(page, panel, "Notes For", "Find worker…");
  await clearReportFilter(page, panel, "Job", "Find Job…");
  await panel.getByRole("textbox", { name: "Search...", exact: true }).fill("");
  const typeButton = reportFilterButton(panel, "Note Type");
  await typeButton.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor({ state: "visible" });
  await listbox.getByRole("option", { name: DAILY_NOTE_OPTION, exact: true }).click();
  await typeButton.click();
  await listbox.waitFor({ state: "hidden" });
  await setReportInterval(page, panel, interval);
  const download = await readyDownloadButton(page);
  // Recheck after the date change; acquisition scope is evidence used downstream.
  await verifyDailyNoteFilter(page, panel);
  await verifyUnrestrictedNotesFilters(panel);
  return { panel, download, scope: "daily_timesheet" };
}

export async function downloadWorkbook(page, context, button, targetPath, approved) {
  if (!approved) {
    throw new Error(
      "Live report downloads are awaiting approval for Supercrew's signed report storage origin. No report request was made.",
    );
  }
  let settle;
  let reject;
  const result = new Promise((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  const attach = (sourcePage) => sourcePage.on("download", onDownload);
  const onDownload = async (download) => {
    try {
      const origin = new URL(download.url()).origin;
      if (![new URL(REPORT_URL).origin, REPORT_DOWNLOAD_ORIGIN].includes(origin)) {
        await download.cancel();
        throw new Error("Supercrew returned an unexpected report download origin.");
      }
      await download.saveAs(targetPath);
      await chmod(targetPath, 0o600);
      if ((await stat(targetPath)).size > MAX_REPORT_BYTES) {
        throw new Error("The source report exceeds the 10 MB limit.");
      }
      const bytes = await readFile(targetPath);
      settle(validateWorkbookBytes(bytes));
    } catch (error) {
      reject(error);
    }
  };
  const onResponse = async (response) => {
    if (!isApprovedReportResponse(response)) return;
    try {
      const size = Number(response.headers()["content-length"] ?? 0);
      if (size > MAX_REPORT_BYTES) throw new Error("The source report exceeds the 10 MB limit.");
      // Some exports navigate to a signed XLSX response instead of dispatching a
      // download. This uses the normal browser response; no private API/fetch URL
      // is scraped or separately requested.
      await response.finished();
      let bytes;
      try {
        bytes = await response.body();
      } catch {
        // Attachment responses may not expose a body; the download event owns
        // that path. Do not request another source report just to get a body.
        return;
      }
      settle(validateWorkbookBytes(bytes));
    } catch (error) {
      reject(error);
    }
  };
  attach(page);
  context.on("page", attach);
  context.on("response", onResponse);
  const timer = setTimeout(
    () =>
      reject(
        new Error(
          "Supercrew's Excel export timed out. Check source login/report access before requesting another download.",
        ),
      ),
    90000,
  );
  try {
    await button.click();
    return await result;
  } finally {
    clearTimeout(timer);
    context.off("page", attach);
    context.off("response", onResponse);
    for (const openPage of context.pages()) openPage.off("download", onDownload);
  }
}

export async function createWorkerBrowser(config, headless = true) {
  const { chromium } = await import("@playwright/test");
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless,
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await installReportDownloadGuard(config, context);
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export async function createPortableWorkerBrowser(config, storageState, headless = true) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({
      storageState,
      acceptDownloads: true,
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    await installReportDownloadGuard(config, context);
    return { browser, context, page: await context.newPage() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function installReportDownloadGuard(config, context) {
  // Do not contact the provider export origin until the specific report storage
  // transfer has been approved. Login/profile setup can still be completed.
  await context.route(`${REPORT_DOWNLOAD_ORIGIN}/**`, async (route) => {
    if (!config.reportDownloadsApproved) return route.abort("blockedbyclient");
    return route.continue();
  });
}
