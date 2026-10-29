import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LaborSyncState } from "@/lib/labor/contract";
import { LaborDownloadButton, laborSyncPresentation } from "./sync-view";

const sync = (patch: Partial<LaborSyncState> = {}): LaborSyncState => ({
  enabled: false,
  hour: 6,
  timeZone: "America/New_York",
  lookbackDays: 14,
  status: "idle",
  lastAttemptAt: "2026-10-13T19:03:00.000Z",
  lastSuccessAt: "2026-10-13T19:03:05.000Z",
  nextRunAt: null,
  lastError: null,
  workerHeartbeatAt: "2026-10-13T19:03:05.000Z",
  command: null,
  commandId: null,
  ...patch,
});

function button(presentation: ReturnType<typeof laborSyncPresentation>) {
  return renderToStaticMarkup(
    <LaborDownloadButton presentation={presentation} onClick={vi.fn()} />,
  );
}

describe("Supercrew download request presentation", () => {
  it("shows a persisted idle request as queued and disables its actual duplicate button", () => {
    const view = laborSyncPresentation(sync({ command: "run", commandId: "TEST-COMMAND" }));
    expect(view.statusLabel).toBe("Download queued");
    expect(view.message).toContain("No worker has claimed it yet");
    expect(view.message).toContain("worker must be running");
    expect(button(view)).toMatch(/disabled=""[^>]*>Download queued<\/button>/);
    expect(button(view)).not.toContain("Ready");
  });

  it("distinguishes a claimed download from a queued request", () => {
    const view = laborSyncPresentation(sync({ command: "run", status: "running" }));
    expect(view.statusLabel).toBe("Downloading reports");
    expect(button(view)).toMatch(/disabled=""[^>]*>Downloading…<\/button>/);
    expect(view.message).toContain("downloading and checking both reports");
    expect(view.message).not.toContain("No worker has claimed");
  });

  it("returns the button to an available queue action after completion without inferring offline state", () => {
    const view = laborSyncPresentation(sync());
    expect(view.statusLabel).toBe("Ready");
    expect(view.message).toBeNull();
    expect(button(view)).toContain(">Queue download</button>");
    expect(button(view)).not.toContain("disabled");
    expect(JSON.stringify(view)).not.toMatch(/offline|hourly/i);
  });

  it("preserves sign-in and failure warnings while the request remains queued", () => {
    for (const [status, warning] of [
      ["needs_login", "sign-in required"],
      ["not_connected", "not connected"],
      ["failed", "needs attention"],
    ] as const) {
      const view = laborSyncPresentation(sync({ command: "run", status }));
      expect(view.statusLabel).toBe(`Download queued · ${warning}`);
      expect(view.downloadDisabled).toBe(true);
      expect(view.downloadLabel).toBe("Download queued");
    }
  });

  it("explains that a sign-in request needs the operator’s connection setup", () => {
    for (const status of ["idle", "running"] as const) {
      const view = laborSyncPresentation(sync({ command: "connect", status }));
      expect(view.statusLabel).toBe("Sign-in requested");
      expect(view.message).toContain("person managing the worker must complete");
      expect(view.message).not.toContain("open sign-in");
      expect(view.downloadLabel).not.toContain("Downloading");
      expect(view.downloadDisabled).toBe(true);
    }
  });

  it("keeps the request disabled while saving and preserves the local idle action", () => {
    expect(button(laborSyncPresentation(sync(), "run"))).toMatch(
      /disabled=""[^>]*>Queuing…<\/button>/,
    );
    expect(button(laborSyncPresentation(sync(), "", true))).toContain(">Download now</button>");
    expect(button(laborSyncPresentation(sync({ command: "run" }), "", true))).toMatch(
      /disabled=""[^>]*>Download queued<\/button>/,
    );
    expect(laborSyncPresentation(null).downloadDisabled).toBe(true);
    expect(laborSyncPresentation(sync(), "import").downloadDisabled).toBe(true);
  });
});
