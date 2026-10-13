import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearReportFilter,
  completeSourceConnection,
  downloadWorkbook,
  setReportInterval,
  verifyDailyNoteFilter,
  verifyUnrestrictedNotesFilters,
} from "./browser.mjs";
import {
  monthIndex,
  monthLabel,
  REPORT_DOWNLOAD_ORIGIN,
  REPORT_URL,
  reportDateLabel,
} from "./core.mjs";

function sourceConnectionFixture({ correctAccount = true } = {}) {
  let url = "https://app.supercrew.com/dashboard";
  const observations = [];
  const company = { count: async () => (correctAccount ? 1 : 0) };
  const reportTab = {
    or: (other) => {
      assert.equal(other, company);
      return {
        first: () => ({
          waitFor: async (options) => {
            observations.push({ kind: "setup", url, options });
            assert.equal(options.timeout, 600000);
            assert.equal(options.state, "visible");
          },
        }),
      };
    },
    waitFor: async (options) => {
      observations.push({ kind: "verify", url, options });
      assert.equal(url, REPORT_URL);
      assert.equal(options.timeout, 20000);
    },
  };
  return {
    observations,
    page: {
      url: () => url,
      getByRole: (role, options) => {
        assert.equal(role, "tab");
        assert.equal(options.name, "Timesheet Report");
        return reportTab;
      },
      getByText: (label, options) => {
        assert.equal(label, "Sammy’s Visionary Landscape");
        assert.equal(options.exact, true);
        return company;
      },
      goto: async (destination, options) => {
        assert.equal(destination, REPORT_URL);
        assert.equal(options.timeout, 45000);
        observations.push({ kind: "navigate", url: destination });
        url = destination;
      },
    },
  };
}

test("connection completes when human login returns to the company dashboard", async () => {
  const fixture = sourceConnectionFixture();
  await completeSourceConnection(fixture.page);
  assert.deepEqual(
    fixture.observations.map((item) => item.kind),
    ["setup", "navigate", "verify"],
  );
  assert.equal(fixture.observations[0].url, "https://app.supercrew.com/dashboard");
});

test("authenticated source UI still requires the expected company before connection succeeds", async () => {
  const fixture = sourceConnectionFixture({ correctAccount: false });
  await assert.rejects(completeSourceConnection(fixture.page), /Sammy’s Visionary Landscape/);
});

test("uncompleted human sign-in shows a clear timeout without locator details", async () => {
  const timeout = new Error("locator.or(locator).first(): Timeout 600000ms exceeded");
  timeout.name = "TimeoutError";
  let navigated = false;
  const page = {
    getByText: () => ({}),
    getByRole: () => ({
      or: () => ({
        first: () => ({
          waitFor: async () => {
            throw timeout;
          },
        }),
      }),
    }),
    goto: async () => {
      navigated = true;
    },
  };
  await assert.rejects(completeSourceConnection(page), {
    message:
      "Supercrew sign-in was not completed within 10 minutes; use Connect Supercrew to try again.",
  });
  assert.equal(navigated, false);
});

test("filter clearing removes every selected option and retained worker search", async () => {
  let selected = 3;
  let searchValue = "ross";
  let visible = false;
  const button = {
    click: async () => {
      visible = !visible;
    },
  };
  const listbox = {
    waitFor: async ({ state }) => assert.equal(visible, state === "visible"),
    getByPlaceholder: () => ({
      count: async () => 1,
      fill: async (text) => {
        searchValue = text;
      },
    }),
    locator: (selector) => {
      assert.equal(selector, '[role="option"][aria-selected="true"]');
      return {
        count: async () => selected,
        first: () => ({
          click: async () => {
            selected--;
          },
        }),
      };
    },
  };
  await clearReportFilter(
    { getByRole: () => listbox },
    {
      getByRole: (role, options) => {
        assert.equal(role, "button");
        assert.equal(options.name.test("(3) Worker"), true);
        assert.equal(options.name.test("Worker"), true);
        assert.equal(options.name.test("Notes For"), false);
        return button;
      },
    },
    "Worker",
    "Find Worker…",
  );
  assert.equal(selected, 0);
  assert.equal(searchValue, "");
  assert.equal(visible, false);
});

test("daily-note scope requires the sole selected source type after date/filter changes", async () => {
  for (const [count, attribute, accepted] of [
    [1, "true", true],
    [2, "true", false],
    [1, "false", false],
  ]) {
    let open = false;
    const button = {
      click: async () => {
        open = !open;
      },
    };
    const listbox = {
      waitFor: async ({ state }) => assert.equal(open, state === "visible"),
      locator: (selector) => {
        assert.equal(selector, '[role="option"][aria-selected="true"]');
        return { count: async () => count };
      },
      getByRole: (role, options) => {
        assert.equal(role, "option");
        assert.equal(options.name, "Daily Timesheet Note Not associated with a job");
        assert.equal(options.exact, true);
        return { getAttribute: async () => attribute };
      },
    };
    const page = { getByRole: () => listbox };
    const panel = {
      getByRole: (role, options) => {
        assert.equal(role, "button");
        assert.equal(options.name.test("(1) Note Type"), true);
        return button;
      },
    };
    if (accepted) await verifyDailyNoteFilter(page, panel);
    else
      await assert.rejects(verifyDailyNoteFilter(page, panel), /sole Daily Timesheet Note filter/);
    assert.equal(open, false);
  }
});

test("complete Notes acquisition refuses a retained owner/job filter or text search", async () => {
  for (const restricted of [null, "Notetaker", "Notes For", "Job", "Search..."]) {
    const panel = {
      getByRole: (role, options) => {
        if (role === "textbox") {
          assert.equal(options.name, "Search...");
          return {
            inputValue: async () => (restricted === "Search..." ? "TEST retained search" : ""),
          };
        }
        const name = ["Notetaker", "Notes For", "Job"].find((label) => options.name.test(label));
        assert.ok(name);
        return { innerText: async () => (restricted === name ? `(1) ${name}` : name) };
      },
    };
    if (restricted)
      await assert.rejects(
        verifyUnrestrictedNotesFilters(panel),
        /Complete note coverage was not verified/,
      );
    else await verifyUnrestrictedNotesFilters(panel);
  }
});

function calendarFixture({ stuck = false } = {}) {
  let interval = { start: "2026-09-24", end: "2026-09-30" };
  let month = "July 2026";
  let visible = false;
  let clicks = 0;
  const button = {
    innerText: async () => reportDateLabel(interval),
    click: async () => {
      visible = !visible;
    },
  };
  const day = (name) => ({
    click: async () => {
      clicks++;
      const parsed = new Date(`${month} 1 UTC`);
      const date = `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(name).padStart(2, "0")}`;
      if (stuck) return;
      if (interval.start !== interval.end) interval = { start: date, end: date };
      else
        interval = {
          start: [interval.start, date].sort()[0],
          end: [interval.start, date].sort()[1],
        };
    },
  });
  const tooltip = {
    waitFor: async ({ state }) => assert.equal(visible, state === "visible"),
    locator: () => ({ innerText: async () => month }),
    getByRole: (role, options = {}) => {
      if (role === "grid")
        return {
          getAttribute: async () => "react-day-picker-82",
          getByRole: (_, child) => day(child.name),
        };
      return {
        click: async () => {
          if (options.name === "Custom") return;
          const index = monthIndex(month) + (options.name.includes("next") ? 1 : -1);
          const year = Math.floor(index / 12);
          month = monthLabel(`${year}-${String((index % 12) + 1).padStart(2, "0")}-01`);
        },
      };
    },
  };
  return {
    page: { getByRole: () => tooltip },
    panel: { getByRole: () => button },
    current: () => ({ interval, visible, clicks }),
  };
}

test("date selection navigates the calendar and verifies the complete visible interval", async () => {
  const fixture = calendarFixture();
  const interval = { start: "2026-09-15", end: "2026-09-28" };
  await setReportInterval(fixture.page, fixture.panel, interval);
  assert.deepEqual(fixture.current().interval, interval);
  assert.equal(fixture.current().visible, false);
  assert.equal(fixture.current().clicks, 2);
});

test("changed calendar behavior fails closed instead of exporting the wrong period", async () => {
  const fixture = calendarFixture({ stuck: true });
  await assert.rejects(
    setReportInterval(fixture.page, fixture.panel, { start: "2026-09-15", end: "2026-09-28" }),
    /exact requested report period/,
  );
  assert.equal(fixture.current().clicks, 4);
});

function downloadFixture() {
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.pages = () => [page];
  return { page, context };
}

test("unapproved downloads never click the source export button", async () => {
  const { page, context } = downloadFixture();
  let clicked = false;
  await assert.rejects(
    downloadWorkbook(
      page,
      context,
      {
        click: async () => {
          clicked = true;
        },
      },
      "/tmp/unused.xlsx",
      false,
    ),
    /awaiting approval/,
  );
  assert.equal(clicked, false);
});

test("normal browser download is saved privately before the context closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labor-worker-test-"));
  try {
    const { page, context } = downloadFixture();
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 10]);
    const button = {
      click: async () =>
        page.emit("download", {
          url: () => `${REPORT_DOWNLOAD_ORIGIN}/report.xlsx?private=not-logged`,
          saveAs: async (path) => writeFile(path, bytes),
          cancel: async () => {},
        }),
    };
    assert.deepEqual(
      await downloadWorkbook(page, context, button, join(directory, "report.xlsx"), true),
      bytes,
    );
    assert.equal(page.listenerCount("download"), 0);
    assert.equal(context.listenerCount("response"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected download origins are cancelled without importing", async () => {
  const { page, context } = downloadFixture();
  let cancelled = false;
  const button = {
    click: async () =>
      page.emit("download", {
        url: () => "https://unapproved.example/other.xlsx",
        cancel: async () => {
          cancelled = true;
        },
      }),
  };
  await assert.rejects(
    downloadWorkbook(page, context, button, "/tmp/unused.xlsx", true),
    /unexpected report download origin/,
  );
  assert.equal(cancelled, true);
});

test("provider navigation fallback reads only the normal approved XLSX browser response", async () => {
  const { page, context } = downloadFixture();
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const response = {
    url: () => `${REPORT_DOWNLOAD_ORIGIN}/report.xlsx?signature=private`,
    status: () => 200,
    headers: () => ({
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    finished: async () => null,
    body: async () => bytes,
  };
  const button = { click: async () => context.emit("response", response) };
  assert.deepEqual(await downloadWorkbook(page, context, button, "/tmp/unused.xlsx", true), bytes);
});
