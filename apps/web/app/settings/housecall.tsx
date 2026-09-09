"use client";
import { useState } from "react";
import styles from "../manager/manager.module.css";

export function HousecallSettings() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: "health" | "sync") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/housecall/${action}`, {
        method: action === "health" ? "GET" : "POST",
        cache: "no-store",
      });
      const data = await response.json();
      if (action === "health" && typeof data.readsEnabled === "boolean") {
        setMessage(
          !data.readsEnabled
            ? "Housecall access is disabled. Your administrator can configure read access."
            : !data.configured
              ? "A server-side Housecall credential has not been configured."
              : data.connected
                ? "Connected. Live writes require separate explicit approval for each export."
                : "Could not connect to Housecall. Ask your administrator to check access and try again.",
        );
      } else if (!response.ok)
        throw new Error("Housecall request failed. Check your access and try again.");
      else
        setMessage(
          data.skipped === "reads_disabled"
            ? "Housecall read access is disabled."
            : data.skipped
              ? "A job refresh is already running. Try again shortly."
              : `Refreshed ${data.count} jobs. No Housecall records were changed.`,
        );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Housecall is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.settingsCard} aria-labelledby="housecall-heading">
      <h2 id="housecall-heading">Housecall connection</h2>
      <p>Check the connection or refresh the job list. Both actions only read Housecall data.</p>
      <p>
        Live writes stay disabled until explicitly authorized for specific exports and test jobs.
      </p>
      <button
        type="button"
        className={styles.primaryButton}
        disabled={busy}
        onClick={() => run("health")}
      >
        Check connection
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => run("sync")}>
        Refresh jobs
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
