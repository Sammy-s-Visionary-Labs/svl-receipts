import type { AuthzActor } from "@svl/domain";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../page";
import ReceiptPage from "../receipts/[id]/page";
import SettingsPage from "../settings/page";
import UpdatesPage from "../updates/page";
import { ManagerShell } from "./shell";

const { loadActor } = vi.hoisted(() => ({ loadActor: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ getActorFromCookies: loadActor }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("./dashboard", () => ({
  ManagerDashboard: ({ laborEnabled }: { laborEnabled: boolean }) => (
    <div data-labor-enabled={String(laborEnabled)}>Authorized manager dashboard</div>
  ),
}));
vi.mock("./receipt-review", () => ({
  ReceiptReview: ({ laborEnabled }: { laborEnabled: boolean }) => (
    <div data-labor-enabled={String(laborEnabled)}>Authorized receipt review</div>
  ),
}));
vi.mock("../sign-out-button", () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));

function actor(role: AuthzActor["role"]): AuthzActor {
  return { userId: "11111111-1111-4111-8111-111111111111", role, disabled: false };
}

describe("manager page access and role-aware navigation", () => {
  beforeEach(() => {
    loadActor.mockReset();
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects signed-out visitors before returning a dashboard", async () => {
    loadActor.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow("redirect:/login");
  });

  it("does not render the manager client or navigation for a worker", async () => {
    loadActor.mockResolvedValue(actor("worker"));
    await expect(Home()).rejects.toThrow("redirect:/field");
  });

  it.each(["manager", "admin"] as const)("renders the dashboard for an active %s", async (role) => {
    loadActor.mockResolvedValue(actor(role));
    expect(renderToStaticMarkup(await Home())).toContain("Authorized manager dashboard");
  });

  it("hides Settings from managers while exposing it to administrators", () => {
    const manager = renderToStaticMarkup(
      <ManagerShell actorRole="manager" laborEnabled={false} active="inbox">
        Queue
      </ManagerShell>,
    );
    const admin = renderToStaticMarkup(
      <ManagerShell actorRole="admin" laborEnabled={false} active="settings">
        Settings
      </ManagerShell>,
    );
    expect(manager).toContain("Inbox");
    expect(manager).toContain('href="/updates"');
    expect(admin).toContain('href="/updates"');
    expect(manager).not.toContain('href="/?tab=history');
    expect(admin).not.toContain('href="/?tab=history');
    expect(manager).not.toContain('href="/settings"');
    expect(admin).toContain('href="/settings"');
  });

  it("uses the supplied navigation flag even when private feature environment is absent", () => {
    vi.stubEnv("LABOR_ENABLED", undefined);
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", undefined);
    const render = (laborEnabled: boolean) =>
      renderToStaticMarkup(
        <ManagerShell actorRole="manager" laborEnabled={laborEnabled} active="inbox">
          Queue
        </ManagerShell>,
      );
    expect(render(true)).toContain('href="/labor-hours"');
    expect(render(true)).toContain('href="/jobs"');
    expect(render(false)).not.toContain('href="/labor-hours"');
    expect(render(false)).not.toContain('href="/jobs"');
    vi.stubEnv("LABOR_ENABLED", "1");
    expect(render(false)).not.toContain('href="/labor-hours"');
  });

  it.each(["1", "0"])(
    "passes server-evaluated feature flag %s to both receipt clients",
    async (flag) => {
      vi.stubEnv("LABOR_ENABLED", flag);
      loadActor.mockResolvedValue(actor("manager"));
      const attribute = `data-labor-enabled="${flag === "1"}"`;
      expect(renderToStaticMarkup(await Home())).toContain(attribute);
      expect(
        renderToStaticMarkup(
          await ReceiptPage({ params: Promise.resolve({ id: "TEST-receipt" }) }),
        ),
      ).toContain(attribute);
    },
  );
  it.each(["manager", "admin"] as const)("allows an active %s to read Updates", async (role) => {
    loadActor.mockResolvedValue(actor(role));
    const html = renderToStaticMarkup(await UpdatesPage());
    expect(html).toContain('href="/updates"');
    expect(html).toMatch(/href="\/updates"[^>]*aria-current="page"/);
  });

  it("protects direct Updates access from workers and signed-out visitors", async () => {
    loadActor.mockResolvedValue(actor("worker"));
    await expect(UpdatesPage()).rejects.toThrow("redirect:/field");
    loadActor.mockResolvedValue(null);
    await expect(UpdatesPage()).rejects.toThrow("redirect:/login");
  });

  it("denies Updates to an inactive manager even if an actor object is present", async () => {
    loadActor.mockResolvedValue({ ...actor("manager"), disabled: true });
    await expect(UpdatesPage()).rejects.toThrow("redirect:/login");
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
