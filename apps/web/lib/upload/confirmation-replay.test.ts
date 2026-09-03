import { RECEIPT_STATUSES } from "@svl/domain";
import { describe, expect, it } from "vitest";
import { committedConfirmationReplay } from "./confirmation-replay";

describe("committed confirmation replay", () => {
  it("acknowledges the same confirmed manifest after every post-submission transition", () => {
    for (const status of RECEIPT_STATUSES.filter((value) => value !== "upload_pending")) {
      expect(
        committedConfirmationReplay({
          id: "receipt-1",
          status,
          submittedAt: "2026-09-01T12:00:00.000Z",
          checksumsMatch: true,
        }),
      ).toEqual({
        id: "receipt-1",
        status: "submitted",
        submittedAt: "2026-09-01T12:00:00.000Z",
      });
    }
  });

  it("rejects an uncommitted session or a different manifest", () => {
    expect(
      committedConfirmationReplay({
        id: "receipt-1",
        status: "upload_pending",
        submittedAt: null,
        checksumsMatch: true,
      }),
    ).toBeNull();
    expect(
      committedConfirmationReplay({
        id: "receipt-1",
        status: "processing",
        submittedAt: "2026-09-01T12:00:00.000Z",
        checksumsMatch: false,
      }),
    ).toBeNull();
  });
});
