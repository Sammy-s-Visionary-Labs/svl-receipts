import { describe, expect, it, vi } from "vitest";
import { restoreInitialSession } from "./session-restore";

describe("restoreInitialSession", () => {
  it("returns a restored session when storage succeeds", async () => {
    const session = { access_token: "token" };
    const result = await restoreInitialSession(
      vi.fn().mockResolvedValue({ data: { session }, error: null }),
    );

    expect(result).toEqual({ kind: "session", session });
  });

  it("settles as revoked when Supabase reports an invalid stored session", async () => {
    const result = await restoreInitialSession(
      vi.fn().mockResolvedValue({ data: { session: null }, error: new Error("expired") }),
    );

    expect(result).toEqual({ kind: "revoked" });
  });

  it("settles as revoked when session storage rejects", async () => {
    const result = await restoreInitialSession(vi.fn().mockRejectedValue(new Error("storage")));

    expect(result).toEqual({ kind: "revoked" });
  });
});
