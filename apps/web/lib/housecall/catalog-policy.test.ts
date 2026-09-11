import { describe, expect, it } from "vitest";
import {
  HOUSECALL_JOB_STALE_MS,
  housecallCatalogJobIsStale,
  housecallJobWindow,
} from "./catalog-policy";

const now = Date.parse("2026-09-09T16:00:00.000Z");
const at = (offset: number) => new Date(now + offset).toISOString();

describe("saved Housecall job freshness policy", () => {
  it.each([null, undefined, "", "invalid-date", 123])(
    "treats missing or invalid provider verification dates as stale: %s",
    (synced_at) => {
      expect(housecallCatalogJobIsStale({ source: "housecall", synced_at }, now)).toBe(true);
    },
  );
  it("accepts fresh verification through 26 hours and rejects older evidence", () => {
    expect(HOUSECALL_JOB_STALE_MS).toBe(26 * 60 * 60 * 1000);
    for (const offset of [0, -1, -HOUSECALL_JOB_STALE_MS])
      expect(housecallCatalogJobIsStale({ source: "housecall", synced_at: at(offset) }, now)).toBe(
        false,
      );
    expect(
      housecallCatalogJobIsStale(
        { source: "housecall", synced_at: at(-HOUSECALL_JOB_STALE_MS - 1) },
        now,
      ),
    ).toBe(true);
  });
  it("tolerates one minute of clock skew but rejects implausible future evidence", () => {
    expect(housecallCatalogJobIsStale({ source: "housecall", synced_at: at(60_000) }, now)).toBe(
      false,
    );
    expect(housecallCatalogJobIsStale({ source: "housecall", synced_at: at(60_001) }, now)).toBe(
      true,
    );
  });
  it.each([undefined, null, "manual"])("preserves legacy or manual source %s", (source) => {
    expect(housecallCatalogJobIsStale({ source, synced_at: null }, now)).toBe(false);
    expect(
      housecallCatalogJobIsStale({ source, synced_at: at(-HOUSECALL_JOB_STALE_MS - 1) }, now),
    ).toBe(false);
  });
});

describe("active and recent job search windows", () => {
  const day = 86_400_000;
  it("defaults to 30 days back and 90 days forward without changing the clock", () => {
    expect(housecallJobWindow({}, now)).toEqual({
      recentSince: at(-30 * day),
      upcomingUntil: at(90 * day),
    });
  });
  it("accepts independent whole-day bounds from 1 through 365", () => {
    expect(
      housecallJobWindow(
        { HOUSECALL_ACTIVE_LOOKBACK_DAYS: "1", HOUSECALL_ACTIVE_LOOKAHEAD_DAYS: "365" },
        now,
      ),
    ).toEqual({
      recentSince: at(-day),
      upcomingUntil: at(365 * day),
    });
    expect(
      housecallJobWindow(
        { HOUSECALL_ACTIVE_LOOKBACK_DAYS: "365", HOUSECALL_ACTIVE_LOOKAHEAD_DAYS: "1" },
        now,
      ),
    ).toEqual({
      recentSince: at(-365 * day),
      upcomingUntil: at(day),
    });
  });
  it.each(["HOUSECALL_ACTIVE_LOOKBACK_DAYS", "HOUSECALL_ACTIVE_LOOKAHEAD_DAYS"])(
    "rejects invalid configured window %s",
    (key) => {
      for (const value of [
        "0",
        "-1",
        "366",
        "1.5",
        "NaN",
        "Infinity",
        " 30 ",
        "1e2",
        "9007199254740992",
      ])
        expect(() => housecallJobWindow({ [key]: value }, now)).toThrow(
          `invalid_housecall_job_window:${key}`,
        );
    },
  );
});
