"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import styles from "./email.module.css";

type Item = {
  id: string;
  status: string;
  subject: string | null;
  sender: string | null;
  created_at: string;
  last_error: string | null;
  raw_deleted_at?: string | null;
  email_receipt_documents: { receipt_id: string; filename: string }[];
};
const labels: Record<string, string> = {
  awaiting_upload: "Awaiting upload",
  queued: "Queued",
  processing: "Preparing",
  imported: "Sent to receipt workflow",
  needs_attention: "Needs attention",
};
const errors: Record<string, string> = {
  pdf_page_limit:
    "This PDF exceeds the five-page receipt limit. Split it into separate receipts and send it again.",
  invalid_or_locked_pdf: "The PDF is damaged or password-protected. Send an unlocked copy.",
  email_body_limit: "The email body is too long. Send the receipt as a PDF or image.",
  unsupported_attachment:
    "An attachment format is not supported. Send PDF, images, or an attached email (.eml).",
  attachment_limit: "This message has too many attachments or pages. Send smaller groups.",
  no_receipt_content: "No readable receipt content was found.",
  unsupported_image: "Send this image as JPEG, PNG, or PDF.",
  invalid_image: "An image could not be opened. Send another copy.",
  multipage_image_unsupported: "Send this multi-page image as a PDF.",
  processing_failed: "Preparation could not finish. Retry the import.",
  preparation_timeout: "Preparation took too long. Try a smaller document.",
  email_checksum_mismatch:
    "The original email failed its integrity check. Contact the administrator.",
};
export function EmailSettings() {
  const [lastContactAt, setLastContactAt] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]),
    [configured, setConfigured] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/manager/email-imports", { cache: "no-store" });
      if (!response.ok) throw new Error("Email intake status could not be loaded.");
      const data = await response.json();
      setItems(data.imports);
      setConfigured(data.configured);
      setLastContactAt(data.lastContactAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(id: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/email-imports/${id}/retry`, { method: "POST" });
      if (!r.ok) throw new Error("Retry could not be started.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
      setBusy(false);
    }
  }
  return (
    <section className={styles.card} aria-labelledby="email-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>RECEIPT SOURCES</p>
          <h2 id="email-heading">Email receipts</h2>
          <p>recisvl@gmail.com</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p>
        {configured
          ? lastContactAt
            ? `Last connected ${new Date(lastContactAt).toLocaleString()}. Scheduled checks run every eight hours.`
            : "Ready to connect Gmail. Complete Google setup to begin automatic checks every eight hours."
          : "Email intake awaits administrator setup and Google mailbox authorization."}
      </p>
      <p className={styles.note}>
        PDFs, images, forwarded emails, and email-body receipts enter the same review inbox.
        Housecall receives data only after manager approval.
      </p>
      {error && <p role="alert">{error}</p>}
      {!busy && !items.length && (
        <div className={styles.empty}>No emails received by the importer yet.</div>
      )}
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <div className={styles.row}>
              <div>
                <strong>{item.subject || "Receipt email"}</strong>
                <p>{item.sender || "Original email awaiting preparation"}</p>
                <small>{new Date(item.created_at).toLocaleString()}</small>
              </div>
              <span className={item.status === "needs_attention" ? styles.warning : styles.badge}>
                {labels[item.status]}
              </span>
            </div>
            {item.last_error && (
              <p role="status">
                {errors[item.last_error] || "This email needs administrator attention."}
              </p>
            )}
            <div className={styles.actions}>
              {item.email_receipt_documents.map((doc) => (
                <Link key={doc.receipt_id} href={`/receipts/${doc.receipt_id}`}>
                  Review {doc.filename}
                </Link>
              ))}
              {item.status !== "awaiting_upload" && !item.raw_deleted_at && (
                <a href={`/api/manager/email-imports/${item.id}/original`}>Original email</a>
              )}
              {item.status === "needs_attention" && (
                <button type="button" disabled={busy} onClick={() => void retry(item.id)}>
                  Retry preparation
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length === 50 && (
        <p className={styles.note}>
          Showing the latest 50 emails. Imported receipts remain available in receipt history.
        </p>
      )}
    </section>
  );
}
