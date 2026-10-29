import { describe, expect, it } from "vitest";
import { LABOR_HOUSECALL_TEST_JOB, laborDestinationAllowed } from "./housecall-destination";

describe("labor provider destination confinement", () => {
  it("leaves the normal reviewed production job selection available when absent", () => {
    expect(laborDestinationAllowed({}, "job_real")).toBe(true);
  });
  it("restricts test mode to exactly the user-nominated job", () => {
    expect(
      laborDestinationAllowed({ LABOR_HOUSECALL_TEST_MODE: "1" }, LABOR_HOUSECALL_TEST_JOB),
    ).toBe(true);
    expect(laborDestinationAllowed({ LABOR_HOUSECALL_TEST_MODE: "1" }, "job_real")).toBe(false);
  });
  it("intersects explicit allowlists with test mode and fails closed on invalid configuration", () => {
    expect(
      laborDestinationAllowed({ LABOR_HOUSECALL_ALLOWED_JOB_IDS: "job_one, job_two" }, "job_two"),
    ).toBe(true);
    expect(
      laborDestinationAllowed({ LABOR_HOUSECALL_ALLOWED_JOB_IDS: "job_one, job_two" }, "job_three"),
    ).toBe(false);
    for (const value of ["", " ", "job_one,", "job/other", "job_one\njob_two"])
      expect(laborDestinationAllowed({ LABOR_HOUSECALL_ALLOWED_JOB_IDS: value })).toBe(false);
    expect(
      laborDestinationAllowed({ LABOR_HOUSECALL_TEST_MODE: "true" }, LABOR_HOUSECALL_TEST_JOB),
    ).toBe(false);
    expect(
      laborDestinationAllowed({
        LABOR_HOUSECALL_TEST_MODE: "1",
        LABOR_HOUSECALL_ALLOWED_JOB_IDS: "job_real",
      }),
    ).toBe(false);
    expect(
      laborDestinationAllowed(
        {
          LABOR_HOUSECALL_TEST_MODE: "1",
          LABOR_HOUSECALL_ALLOWED_JOB_IDS: `${LABOR_HOUSECALL_TEST_JOB},job_real`,
        },
        "job_real",
      ),
    ).toBe(false);
  });
});
