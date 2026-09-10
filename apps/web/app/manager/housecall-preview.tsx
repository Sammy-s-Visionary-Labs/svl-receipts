"use client";
import { useEffect, useRef, useState } from "react";
import type { HousecallExportPreview } from "@/lib/housecall/preview";
import { money } from "./queue-view";
import styles from "./receipt-review.module.css";

const statusLabels: Record<string, string> = {
  ready: "Waiting",
  in_progress: "In progress",
  reconcile_required: "Verification required",
  succeeded: "Verified",
  retryable_failure: "Needs retry review",
  permanent_failure: "Needs administrator review",
};
const blockedLabels: Record<string, string> = {
  no_current_intent:
    "Approve the receipt to freeze its export plan. Live writes still require separate explicit approval.",
  missing_frozen_plan: "This older approval has no frozen export plan and cannot be sent by RA-6.",
  incomplete_frozen_plan: "The frozen plan is missing required images or material lines.",
  destination_not_approved:
    "At least one destination is outside the approved test job list. Export is blocked.",
  destination_unavailable: "A destination is marked unavailable. It needs administrator review.",
  unsupported_quantity_precision:
    "Housecall changed a three-decimal quantity during testing. Quantities with more than two decimal places are blocked; review the material quantity before export.",
};

export function HousecallPreview({ receiptId }: { receiptId: string }) {
  const [preview, setPreview] = useState<HousecallExportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    return () => {
      sequence.current++;
    };
  }, []);
  async function load() {
    const current = ++sequence.current;
    setBusy(true);
    setPreview(null);
    setError("");
    try {
      const response = await fetch(`/api/manager/receipts/${receiptId}/export-preview`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Your session ended. Sign in again."
            : response.status === 403
              ? "Manager access is required."
              : response.status === 404
                ? "Receipt content is no longer available."
                : "Could not load the frozen export plan. Try again or ask an administrator.",
        );
      const body = await response.json();
      if (sequence.current === current) setPreview(body);
    } catch (cause) {
      if (sequence.current === current)
        setError(cause instanceof Error ? cause.message : "Could not load preview.");
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }
  async function checkHousecall() {
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/manager/receipts/${receiptId}/export-reconcile`, {
        method: "POST",
      });
      if (!response.ok)
        throw new Error(
          "Could not verify the Housecall result. Try again or ask an administrator.",
        );
      const result = await response.json();
      if (current !== sequence.current) return;
      setMessage(
        result.skipped
          ? "Housecall verification is currently unavailable. Ask an administrator to check the connection."
          : "Housecall was checked. Any unresolved results remain marked below.",
      );
      await load();
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Housecall verification failed.");
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  }
  return (
    <section className={styles.section} aria-labelledby="housecall-preview-title">
      <h2 id="housecall-preview-title">Housecall export preview</h2>
      <p>
        Inspect the approved destinations, receipt pages, and material costs. Opening this preview
        sends no data to Housecall.
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {busy
          ? "Loading export preview…"
          : preview
            ? "Refresh export preview"
            : "Load export preview"}
      </button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {preview && (
        <div aria-live="polite">
          <p className={styles.notice}>
            {preview.liveWritesEnabled
              ? "Test export mode is configured."
              : "Live Housecall writes are disabled."}{" "}
            Live writes require separate explicit approval for the exact destinations and frozen
            plan. This preview does not grant that approval.
          </p>
          {preview.blockedReasons
            .filter((reason) => reason !== "live_writes_disabled")
            .map((reason) => (
              <p className={styles.notice} key={reason}>
                {blockedLabels[reason] ?? "This export needs administrator review."}
              </p>
            ))}
          {preview.jobs.length > 0 && (
            <>
              {preview.jobs.some((job) =>
                [...job.images, ...job.lines].some((step) =>
                  ["reconcile_required", "in_progress"].includes(step.status),
                ),
              ) && (
                <div>
                  <button type="button" disabled={busy} onClick={() => void checkHousecall()}>
                    Check Housecall result
                  </button>
                  <p>
                    This checks saved results in Housecall. It does not upload images or post costs.
                  </p>
                </div>
              )}
              <p>
                <strong>
                  {money(preview.totalMaterialCostCents)} material costs · Tax excluded
                </strong>
              </p>
              <div className={styles.steps}>
                {preview.jobs.map((job) => (
                  <article key={job.id}>
                    <h3>{job.label}</h3>
                    <p className={styles.meta}>
                      Housecall job ID: <code>{job.id}</code>
                    </p>
                    <p>
                      {job.allowedTestDestination
                        ? "On the approved test job list"
                        : "Blocked: outside the approved test job list"}
                    </p>
                    <strong>{money(job.materialCostCents)} material costs</strong>
                    <h4>Receipt pages</h4>
                    <ul>
                      {job.images.map((image) => (
                        <li key={image.stepId}>
                          Page {image.pageIndex + 1} · {statusLabels[image.status] ?? "Unknown"}
                          {image.externalId && (
                            <div className={styles.meta}>
                              External ID: <code>{image.externalId}</code>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    <h4>Material lines</h4>
                    <ul>
                      {job.lines.map((line) => (
                        <li key={line.stepId}>
                          <strong>{line.description}</strong>
                          <div>
                            {line.qty}
                            {line.uom ? ` ${line.uom}` : ""} × {money(line.unitCostCents)} ={" "}
                            {money(line.extendedCostCents)}
                          </div>
                          <div>{statusLabels[line.status] ?? "Unknown"}</div>
                          {line.externalId && (
                            <div className={styles.meta}>
                              External ID: <code>{line.externalId}</code>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </>
          )}
          {preview.intentId && (
            <details>
              <summary>Frozen plan reference for approval</summary>
              <p className={styles.meta}>
                Intent: <code>{preview.intentId}</code>
              </p>
              <p className={styles.meta}>
                Payload hash: <code>{preview.payloadHash ?? "Unavailable"}</code>
              </p>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
