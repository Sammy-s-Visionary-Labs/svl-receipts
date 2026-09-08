"use client";
import type { ReceiptEvidence } from "@svl/domain";
import { useState } from "react";
import styles from "./receipt-review.module.css";
export function ExtractionEvidence({
  receiptId,
  extractionId,
}: {
  receiptId: string;
  extractionId: string;
}) {
  const [evidence, setEvidence] = useState<ReceiptEvidence[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/manager/receipts/${receiptId}/evidence?extractionId=${encodeURIComponent(extractionId)}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error("Source evidence is unavailable. Check the receipt image or try again.");
      const data = await response.json();
      setEvidence(data.evidence);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load evidence.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={styles.intelligencePanel}>
      <summary>Source evidence for this extraction</summary>
      {!evidence && (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Load source evidence"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {evidence && (
        <ul>
          {evidence.map((item) => (
            <li key={`${item.field}-${item.page_index}-${item.text}`}>
              <strong>{item.field}</strong> · page {item.page_index + 1} · field confidence{" "}
              {Math.round(item.confidence * 100)}%<blockquote>{item.text}</blockquote>
            </li>
          ))}
        </ul>
      )}
      {evidence?.length === 0 && <p>No field evidence was recorded for this extraction version.</p>}
    </details>
  );
}
