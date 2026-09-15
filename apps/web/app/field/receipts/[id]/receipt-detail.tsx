"use client";

import type { WorkerFacingStatus } from "@svl/domain";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FieldApiError, fieldApi } from "@/lib/field/api";
import styles from "../../field.module.css";
import { Icon } from "../../glyph";
import { dateLabel, StatusBadge } from "../../receipt-history";
import { ApiNotice } from "../../shell";

type Detail = {
  id: string;
  workerStatus: WorkerFacingStatus;
  submittedAt: string;
  clarification?: string;
  pages: { pageIndex: number; image: { url: string; expiresAt: string } }[];
  readability: {
    readable: boolean;
    reasons: { code: string; guidance: string }[];
    failedPageIndexes: number[];
  } | null;
};

export function ReceiptDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setDetail(await fieldApi<Detail>(`/api/me/receipts/${encodeURIComponent(id)}`));
      setImageError("");
    } catch (cause) {
      if (cause instanceof FieldApiError && [401, 403, 404].includes(cause.status)) setDetail(null);
      setError(cause instanceof Error ? cause.message : "Could not load receipt.");
    } finally {
      setBusy(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (detail?.workerStatus !== "sent") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [detail, load]);
  const status = detail?.workerStatus;
  const photo = detail?.pages.find((item) => item.pageIndex === page);
  const copy =
    status === "needs_retake"
      ? "This receipt needs clearer photos. Retake it with all pages and send it as a new receipt."
      : status === "approved"
        ? "Your office has approved this receipt. You’re all set."
        : status === "declined"
          ? "This receipt was declined or could not be completed. Contact your office if you have questions."
          : status === "in_review"
            ? "Your receipt is ready for your office to review and match to the right job."
            : "Your photos are received. We’re checking readability and preparing the details for your office.";
  return (
    <>
      <Link href="/field/receipts" className={styles.textLink}>
        ← My receipts
      </Link>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>RECEIPT DETAILS</p>
          <h1>Receipt {id.slice(0, 8).toUpperCase()}</h1>
          <p>
            {detail?.submittedAt
              ? `Sent ${dateLabel(detail.submittedAt)}`
              : "Receipt delivery details"}
          </p>
        </div>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && <ApiNotice error={error} />}
      {busy && !detail && <p role="status">Loading your receipt…</p>}
      {detail && (
        <div className={styles.captureGrid}>
          <section className={styles.detailImagePanel}>
            <div className={styles.sectionTitle}>
              <h2>Receipt photo</h2>
              <span>
                Page {page + 1} of {detail.pages.length}
              </span>
            </div>
            {imageError ? (
              <ApiNotice error={imageError} />
            ) : photo ? (
              // biome-ignore lint/performance/noImgElement: Private signed URLs must bypass image optimization and its shared cache.
              <img
                src={photo.image.url}
                alt={`Receipt page ${page + 1}`}
                className={styles.detailImage}
                onError={() =>
                  setImageError(
                    "The photo link expired or could not load. Refresh to get a new link.",
                  )
                }
              />
            ) : (
              <p className={styles.empty}>This receipt photo is unavailable.</p>
            )}
            {detail.pages.length > 1 && (
              <nav className={styles.pagePicker} aria-label="Receipt pages">
                {detail.pages.map((item) => (
                  <button
                    key={item.pageIndex}
                    type="button"
                    aria-pressed={page === item.pageIndex}
                    onClick={() => {
                      setPage(item.pageIndex);
                      setImageError("");
                    }}
                  >
                    Page {item.pageIndex + 1}
                  </button>
                ))}
              </nav>
            )}
          </section>
          <aside>
            <section className={styles.tipCard}>
              {status && <StatusBadge status={status} />}
              <h2 className={styles.detailTitle}>You’re in the loop.</h2>
              <p>{copy}</p>
              {detail.clarification && (
                <div className={styles.officeNote}>
                  <h3>From your office</h3>
                  <p>{detail.clarification}</p>
                </div>
              )}
              {status === "needs_retake" && (
                <>
                  <ul>
                    {detail.readability?.reasons.map((reason) => (
                      <li key={reason.code}>
                        <Icon name="camera" size={18} />
                        {reason.guidance}
                      </li>
                    ))}
                  </ul>
                  {Boolean(detail.readability?.failedPageIndexes.length) && (
                    <p>
                      Check{" "}
                      {detail.readability?.failedPageIndexes
                        .map((index) => `page ${index + 1}`)
                        .join(", ")}
                      .
                    </p>
                  )}
                  <Link href="/field/new" className={styles.primary}>
                    <Icon name="camera" size={18} />
                    Retake receipt
                  </Link>
                </>
              )}
            </section>
            <div className={styles.bottomTip}>
              <Icon name="help" />
              <p>
                Your office handles job matching and review. Contact them if a receipt needs a
                correction.
              </p>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
