"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import styles from "./labor.module.css";
import { readApi } from "./labor-view";

export function NotesUpload({
  period,
  onImported,
}: {
  period: { from: string; to: string } | undefined;
  onImported: () => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [from, setFrom] = useState(period?.from ?? "");
  const [to, setTo] = useState(period?.to ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [complete, setComplete] = useState(false);
  const [datesVerified, setDatesVerified] = useState(false);
  const periodFrom = period?.from;
  const periodTo = period?.to;
  useEffect(() => {
    if (periodFrom && periodTo) {
      setFrom(periodFrom);
      setTo(periodTo);
    }
  }, [periodFrom, periodTo]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "notes");
      form.append("periodStart", from);
      form.append("periodEnd", to);
      form.append("notesScope", "mixed");
      form.append("complete", complete ? "1" : "0");
      form.append("datesVerified", datesVerified ? "1" : "0");
      await readApi(await fetch("/api/manager/labor/import", { method: "POST", body: form }));
      if (fileInput.current) fileInput.current.value = "";
      setNotice("Notes Report imported. Mixed report comments remain evidence for review.");
      await onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the Notes Report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Upload daily notes">
      <div className={styles.cardHeader}>
        <div>
          <h2>Daily comments</h2>
          <p>Upload the separate Supercrew Notes Report for the work period.</p>
        </div>
      </div>
      <div className={styles.cardBody}>
        <p className={styles.muted}>
          The report can contain several note types. Comments are joined by Employee and work date;
          Notetaker may be an editor. Mixed notes require review before they can correct job
          attribution.
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}
        <form
          className={`${styles.scheduleForm} ${styles.notesForm}`}
          onSubmit={(event) => void upload(event)}
        >
          <label>
            Notes Report
            <input ref={fileInput} type="file" accept=".xlsx" required disabled={busy} />
          </label>
          <label>
            Notes period start
            <input
              type="date"
              value={from}
              required
              onChange={(event) => setFrom(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Notes period end
            <input
              type="date"
              min={from || undefined}
              value={to}
              required
              onChange={(event) => setTo(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className={styles.notesChecks}>
            <label>
              <input
                type="checkbox"
                checked={complete}
                onChange={(event) => setComplete(event.target.checked)}
                disabled={busy}
              />
              This report includes all workers and jobs for the declared period.
            </label>
            <label>
              <input
                type="checkbox"
                checked={datesVerified}
                onChange={(event) => setDatesVerified(event.target.checked)}
                disabled={busy}
              />
              I verified the work dates and time zone against Supercrew.
            </label>
          </div>
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? "Importing notes…" : "Import Notes Report"}
          </button>
        </form>
      </div>
    </section>
  );
}
