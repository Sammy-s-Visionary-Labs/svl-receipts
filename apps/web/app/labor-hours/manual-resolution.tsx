"use client";

import { useRef, useState } from "react";
import type { LaborApprovalHistoryItem } from "@/lib/labor/approval-contract";
import type { LaborManualCorrection } from "@/lib/labor/correction-contract";
import styles from "./labor.module.css";
import approvalStyles from "./labor-approval.module.css";
import { localTime, readApi } from "./labor-view";

/** A receipt of a manager's completed manual work; it never unlocks another send. */
export function LaborManualResolution({ approval }: { approval: LaborApprovalHistoryItem }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<LaborManualCorrection[]>([]);
  const [reason, setReason] = useState("");
  const [providerReference, setReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const frozen = useRef<Record<string, unknown> | null>(null);

  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await readApi<{ corrections: LaborManualCorrection[] }>(
        await fetch(
          `/api/manager/labor/corrections?approvalId=${encodeURIComponent(approval.id)}`,
          { cache: "no-store" },
        ),
      );
      setRecords(result.corrections);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load resolution history.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!confirmed || busy) return;
    if (
      !frozen.current &&
      (reason.trim().length < 10 || !providerReference.trim() || evidence.trim().length < 10)
    ) {
      setError(
        "Enter a reason and evidence of at least 10 characters each, plus a Housecall reference.",
      );
      return;
    }
    frozen.current ??= {
      approvalId: approval.id,
      expectedSnapshotHash: approval.snapshotHash,
      requestId: crypto.randomUUID(),
      confirmed: true,
      reason: reason.trim(),
      providerReference: providerReference.trim(),
      evidence: evidence.trim(),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await readApi<{ correction: LaborManualCorrection }>(
        await fetch("/api/manager/labor/corrections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frozen.current),
        }),
      );
      setRecords((previous) => [
        result.correction,
        ...previous.filter((item) => item.id !== result.correction.id),
      ]);
      frozen.current = null;
      setReason("");
      setReference("");
      setEvidence("");
      setConfirmed(false);
      setNotice(
        "Manual resolution recorded. The original approval and duplicate-hour protections remain in place.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The resolution could not be confirmed. Retry the same record.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={approvalStyles.resolution}>
      <button
        className={styles.textButton}
        type="button"
        disabled={busy}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        {open ? "Close manual resolution" : "Record manual resolution / view history"}
      </button>
      {open && (
        <>
          <p>
            Record a correction or reconciliation you have already completed in Housecall. This
            saves your evidence; it does not change Housecall, mark an uncertain send as verified,
            or allow the same hours to be sent again.
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
          {records.map((item) => (
            <article className={approvalStyles.historyItem} key={item.id}>
              <strong>Manager-recorded resolution · {localTime(item.recordedAt)}</strong>
              <p>{item.reason}</p>
              <p>Housecall reference: {item.providerReference}</p>
              <p className={approvalStyles.description}>{item.evidence}</p>
            </article>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Reason for resolution
              <textarea
                required
                minLength={10}
                maxLength={2000}
                value={reason}
                disabled={busy || !!frozen.current}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label>
              Housecall material ID or reference
              <input
                required
                maxLength={500}
                value={providerReference}
                disabled={busy || !!frozen.current}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
            <label>
              Completed action and evidence
              <textarea
                required
                minLength={10}
                maxLength={4000}
                value={evidence}
                disabled={busy || !!frozen.current}
                onChange={(event) => setEvidence(event.target.value)}
              />
            </label>
            <label className={approvalStyles.check}>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || !!frozen.current}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I checked the actual Housecall job and confirm this resolution is complete.
            </label>
            <button className={styles.button} type="submit" disabled={busy || !confirmed}>
              {busy
                ? "Saving…"
                : frozen.current
                  ? "Retry recording this resolution"
                  : "Save manual resolution"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
