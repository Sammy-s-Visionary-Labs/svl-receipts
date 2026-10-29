import type { LaborSyncState } from "@/lib/labor/contract";
import styles from "./labor.module.css";

const syncLabels: Record<LaborSyncState["status"], string> = {
  not_connected: "Not connected",
  idle: "Ready",
  running: "Downloading reports",
  needs_login: "Sign-in required",
  failed: "Needs attention",
};

export function laborSyncPresentation(sync: LaborSyncState | null, busy = "", development = false) {
  const running = sync?.status === "running" && sync.command !== "connect";
  const queued = sync?.command === "run" && !running;
  let statusLabel = sync ? syncLabels[sync.status] : "";
  let message: string | null = null;
  if (running) {
    message =
      "The worker is downloading and checking both reports. Import history updates after both reports are verified.";
  } else if (queued) {
    statusLabel =
      sync.status === "needs_login"
        ? "Download queued · sign-in required"
        : sync.status === "not_connected"
          ? "Download queued · not connected"
          : sync.status === "failed"
            ? "Download queued · needs attention"
            : "Download queued";
    message =
      "Request saved. No worker has claimed it yet. A configured worker must be running to start the download.";
  } else if (sync?.command === "connect") {
    statusLabel = "Sign-in requested";
    message =
      "Sign-in requested. The person managing the worker must complete normal Supercrew sign-in in its connection setup.";
  }
  return {
    statusLabel,
    message,
    downloadLabel: running
      ? "Downloading…"
      : queued
        ? "Download queued"
        : busy === "run"
          ? "Queuing…"
          : development
            ? "Download now"
            : "Queue download",
    downloadDisabled: !sync || Boolean(busy) || running || sync.command !== null,
  };
}

export function LaborDownloadButton({
  presentation,
  onClick,
}: {
  presentation: ReturnType<typeof laborSyncPresentation>;
  onClick: () => void;
}) {
  return (
    <button
      className={styles.primary}
      type="button"
      disabled={presentation.downloadDisabled}
      onClick={onClick}
    >
      {presentation.downloadLabel}
    </button>
  );
}
