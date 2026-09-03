import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  alert: vi.fn(),
}));

vi.mock("react-native", () => ({ Alert: { alert: runtimeMocks.alert } }));

import { confirmAndSignOut } from "./sign-out";

describe("sign-out queue warning", () => {
  beforeEach(() => {
    runtimeMocks.alert.mockReset();
  });

  it("signs out immediately when the queue is empty", async () => {
    const signOut = vi.fn(async () => undefined);
    await confirmAndSignOut(signOut, async () => 0);
    expect(signOut).toHaveBeenCalledOnce();
    expect(runtimeMocks.alert).not.toHaveBeenCalled();
  });

  it("allows sign-out when queued metadata cannot be read", async () => {
    const signOut = vi.fn(async () => undefined);
    await confirmAndSignOut(signOut, async () => {
      throw new Error("secure_store_unavailable");
    });

    expect(runtimeMocks.alert).toHaveBeenCalledOnce();
    const buttons = runtimeMocks.alert.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });
});
