import type { AuthzActor } from "@svl/domain";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../page";
import SettingsPage from "../settings/page";
import { ManagerShell } from "./shell";

const { loadActor } = vi.hoisted(() => ({ loadActor: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ getActorFromCookies: loadActor }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("./dashboard", () => ({ ManagerDashboard: () => <div>Authorized manager dashboard</div> }));
vi.mock("../sign-out-button", () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));

function actor(role: AuthzActor["role"]): AuthzActor {
  return { userId: "11111111-1111-4111-8111-111111111111", role, disabled: false };
}

describe("manager page access and role-aware navigation", () => {
  beforeEach(() => loadActor.mockReset());

  it("redirects signed-out visitors before returning a dashboard", async () => {
    loadActor.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow("redirect:/login");
  });

  it("does not render the manager client or navigation for a worker", async () => {
    loadActor.mockResolvedValue(actor("worker"));
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("Manager access required");
    expect(html).not.toContain("Authorized manager dashboard");
    expect(html).not.toContain("Main navigation");
  });

  it.each(["manager", "admin"] as const)("renders the dashboard for an active %s", async (role) => {
    loadActor.mockResolvedValue(actor(role));
    expect(renderToStaticMarkup(await Home())).toContain("Authorized manager dashboard");
  });

  it("hides Settings from managers while exposing it to administrators", () => {
    const manager = renderToStaticMarkup(
      <ManagerShell actorRole="manager" active="inbox">
        Queue
      </ManagerShell>,
    );
    const admin = renderToStaticMarkup(
      <ManagerShell actorRole="admin" active="settings">
        Settings
      </ManagerShell>,
    );
    expect(manager).toContain("Inbox");
    expect(manager).toContain("History");
    expect(manager).not.toContain('href="/settings"');
    expect(admin).toContain('href="/settings"');
  });

  it("protects direct navigation to Settings", async () => {
    loadActor.mockResolvedValue(actor("manager"));
    await expect(SettingsPage()).rejects.toThrow("redirect:/");
    loadActor.mockResolvedValue(null);
    await expect(SettingsPage()).rejects.toThrow("redirect:/login");
  });

  it("allows an administrator to inspect their account access", async () => {
    loadActor.mockResolvedValue(actor("admin"));
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("Workspace settings");
    expect(html).toContain("Account access");
  });
});
