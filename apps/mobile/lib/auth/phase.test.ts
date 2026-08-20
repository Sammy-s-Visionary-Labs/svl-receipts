import { describe, expect, it } from "vitest";
import { destinationForPhase, parseMeIdentity, resolveAuthPhase } from "./phase";

describe("resolveAuthPhase", () => {
  it("keeps the splash up until session restore finishes", () => {
    expect(resolveAuthPhase({ booting: true, hasSession: false, role: null, error: null })).toBe(
      "booting",
    );
  });

  it("sends workers to Capture and blocks staff", () => {
    expect(
      resolveAuthPhase({
        booting: false,
        hasSession: true,
        role: "worker",
        error: null,
      }),
    ).toBe("ready");
    expect(
      resolveAuthPhase({
        booting: false,
        hasSession: true,
        role: "manager",
        error: null,
      }),
    ).toBe("wrong_role");
  });

  it("distinguishes missing, revoked, inactive, and offline sessions", () => {
    expect(resolveAuthPhase({ booting: false, hasSession: false, role: null, error: null })).toBe(
      "signed_out",
    );
    expect(
      resolveAuthPhase({
        booting: false,
        hasSession: false,
        role: null,
        error: "revoked",
      }),
    ).toBe("revoked");
    expect(
      resolveAuthPhase({
        booting: false,
        hasSession: true,
        role: null,
        error: "inactive",
      }),
    ).toBe("inactive");
    expect(
      resolveAuthPhase({
        booting: false,
        hasSession: true,
        role: null,
        error: "network",
      }),
    ).toBe("needs_network");
  });
});

describe("destinationForPhase", () => {
  it("maps each phase to a distinct screen", () => {
    expect(destinationForPhase("booting")).toBe("booting");
    expect(destinationForPhase("revoked")).toBe("revoked");
    expect(destinationForPhase("signed_out")).toBe("login");
    expect(destinationForPhase("needs_network")).toBe("offline");
    expect(destinationForPhase("inactive")).toBe("blocked");
    expect(destinationForPhase("wrong_role")).toBe("blocked");
    expect(destinationForPhase("ready")).toBe("tabs");
  });
});

describe("parseMeIdentity", () => {
  it("accepts /api/me payloads and rejects client-supplied junk", () => {
    expect(parseMeIdentity({ userId: "u1", role: "worker" })).toEqual({
      userId: "u1",
      role: "worker",
    });
    expect(parseMeIdentity({ userId: "u1", role: "superadmin" })).toBeNull();
    expect(parseMeIdentity({ role: "worker" })).toBeNull();
  });
});
