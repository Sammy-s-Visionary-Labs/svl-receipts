import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  type AuthzActor,
  actorMayAccessAdminOps,
  actorMayAccessManagerOps,
  actorMayReadReceipt,
  actorMayUseApp,
  parseUserRole,
} from "./authz";

const worker: AuthzActor = { userId: "w1", role: "worker", disabled: false };
const otherWorker: AuthzActor = { userId: "w2", role: "worker", disabled: false };
const manager: AuthzActor = { userId: "m1", role: "manager", disabled: false };
const admin: AuthzActor = { userId: "a1", role: "admin", disabled: false };
const disabledWorker: AuthzActor = { userId: "w3", role: "worker", disabled: true };
const disabledAdmin: AuthzActor = { userId: "a2", role: "admin", disabled: true };

describe("parseUserRole", () => {
  it("accepts documented roles only", () => {
    expect(parseUserRole("worker")).toBe("worker");
    expect(parseUserRole("manager")).toBe("manager");
    expect(parseUserRole("admin")).toBe("admin");
  });

  it("rejects client-supplied junk instead of trusting it", () => {
    expect(parseUserRole("superadmin")).toBeNull();
    expect(parseUserRole("WORKER")).toBeNull();
    expect(parseUserRole({ role: "admin" })).toBeNull();
  });
});

describe("negative permission checks", () => {
  it("keeps error codes stable and free of receipt payloads", () => {
    expect(AUTH_ERROR_CODES.unauthenticated).toBe("unauthenticated");
    expect(AUTH_ERROR_CODES.forbidden).toBe("forbidden");
  });

  it("blocks disabled users even if they still have a session", () => {
    expect(actorMayUseApp(disabledWorker)).toBe(false);
    expect(actorMayUseApp(disabledAdmin)).toBe(false);
    expect(actorMayAccessAdminOps(disabledAdmin)).toBe(false);
    expect(actorMayReadReceipt(disabledWorker, "w3")).toBe(false);
  });

  it("blocks workers from manager and admin operations", () => {
    expect(actorMayAccessManagerOps(worker)).toBe(false);
    expect(actorMayAccessAdminOps(worker)).toBe(false);
    expect(actorMayAccessAdminOps(manager)).toBe(false);
  });

  it("blocks workers from reading another user's receipt", () => {
    expect(actorMayReadReceipt(worker, "w1")).toBe(true);
    expect(actorMayReadReceipt(worker, otherWorker.userId)).toBe(false);
    expect(actorMayReadReceipt(otherWorker, worker.userId)).toBe(false);
  });

  it("allows staff to read any receipt and reach their ops", () => {
    expect(actorMayReadReceipt(manager, worker.userId)).toBe(true);
    expect(actorMayReadReceipt(admin, worker.userId)).toBe(true);
    expect(actorMayAccessManagerOps(manager)).toBe(true);
    expect(actorMayAccessManagerOps(admin)).toBe(true);
    expect(actorMayAccessAdminOps(admin)).toBe(true);
  });
});
