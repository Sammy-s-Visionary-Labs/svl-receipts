import { QUEUE_SIGN_OUT_POLICY } from "@svl/domain";
import { describe, expect, it } from "vitest";
import { countQueuedReceipts, shouldWarnOnSignOut } from "./pending";

describe("sign-out queue guard", () => {
  it("does not delete queued images and warns only when the queue is non-empty", () => {
    expect(QUEUE_SIGN_OUT_POLICY.deleteQueuedImages).toBe(false);
    expect(shouldWarnOnSignOut(0)).toBe(false);
    expect(shouldWarnOnSignOut(2)).toBe(true);
  });

  it("reports an empty queue until RA-24", async () => {
    expect(await countQueuedReceipts()).toBe(0);
  });
});
