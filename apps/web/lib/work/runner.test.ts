import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runWorkBatch } from "./runner";

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: vi.fn(),
}));

describe("work runner batch bounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps provider batches at four and starts the claimed rows concurrently", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: `work-${index}`,
      receipt_id: `receipt-${index}`,
      kind: "readability",
    }));
    let activeStarts = 0;
    let maxActiveStarts = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_work") {
        return { data: rows, error: null };
      }
      if (name === "start_queued_work") {
        activeStarts += 1;
        maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        activeStarts -= 1;
        return { data: null, error: new Error("synthetic start failure") };
      }
      if (name === "fail_work") {
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    });
    vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runWorkBatch({ limit: 20, kinds: ["readability"] })).resolves.toEqual({
      claimed: 4,
      completed: 0,
      failed: 4,
    });

    expect(rpc).toHaveBeenCalledWith(
      "claim_work",
      expect.objectContaining({ p_limit: 4, p_kinds: ["readability"] }),
    );
    expect(maxActiveStarts).toBe(4);
  });
});
