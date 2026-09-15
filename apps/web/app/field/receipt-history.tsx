"use client";

import { WORKER_FACING_LABELS, type WorkerFacingStatus } from "@svl/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FieldApiError, fieldApi } from "@/lib/field/api";
import { type FieldDraft, listDrafts } from "@/lib/field/drafts";
import styles from "./field.module.css";
import { Icon } from "./glyph";
import { ApiNotice, useFieldActor } from "./shell";

type Receipt = {
  id: string;
  status: string;
  workerStatus: WorkerFacingStatus;
  submittedAt: string;
  pageCount: number;
  thumbnail: { url: string; expiresAt: string } | null;
  readability: { reasons: { guidance: string }[] } | null;
};
type History = { receipts: Receipt[]; nextCursor: string | null };
export function dateLabel(date: string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
export function StatusBadge({ status }: { status: WorkerFacingStatus }) {
  return (
    <span className={styles.badge} data-status={status}>
      <span />
      {WORKER_FACING_LABELS[status] ?? "Checking status"}
    </span>
  );
}

export function ReceiptHistory({ overview = false }: { overview?: boolean }) {
  const actor = useFieldActor();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drafts, setDrafts] = useState<FieldDraft[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [filter, setFilter] = useState("all");
  const requestNumber = useRef(0);
  const load = useCallback(async (next: string | null = null) => {
    const request = ++requestNumber.current;
    setBusy(true);
    setError("");
    try {
      const result = await fieldApi<History>(
        `/api/me/receipts${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      );
      if (request !== requestNumber.current) return;
      setReceipts((current) =>
        next
          ? [
              ...current,
              ...result.receipts.filter((item) => !current.some((old) => old.id === item.id)),
            ]
          : result.receipts,
      );
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch (cause) {
      if (
        request === requestNumber.current &&
        cause instanceof FieldApiError &&
        [401, 403].includes(cause.status)
      ) {
        setReceipts([]);
        setCursor(null);
        setLoaded(false);
      }
      if (request === requestNumber.current)
        setError(cause instanceof Error ? cause.message : "Could not load receipts.");
    } finally {
      if (request === requestNumber.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    void listDrafts(actor.userId)
      .then(setDrafts)
      .catch(() =>
        setDraftError(
          "Saved drafts could not be opened in this browser. Reopen the app and try again.",
        ),
      );
    return () => {
      requestNumber.current += 1;
    };
  }, [actor.userId, load]);
  const retakes = receipts.filter((receipt) => receipt.workerStatus === "needs_retake").length;
  const reviewing = receipts.filter((receipt) =>
    ["sent", "in_review"].includes(receipt.workerStatus),
  ).length;
  const approved = receipts.filter((receipt) => receipt.workerStatus === "approved").length;
  const visible = receipts.filter((receipt) => filter === "all" || receipt.workerStatus === filter);
  return (
    <>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>
            {overview ? "READY FOR THE WORKDAY" : "YOUR RECEIPT HISTORY"}
          </p>
          <h1>{overview ? "Good work. Less paperwork." : "My receipts"}</h1>
          <p>
            {overview
              ? "Snap it, send it, and get back to the job."
              : "Follow each receipt from your phone to the office."}
          </p>
        </div>
        {!overview && (
          <Link className={styles.primary} href="/field/new">
            <Icon name="plus" size={18} />
            New receipt
          </Link>
        )}
      </div>
      {overview && (
        <section className={styles.captureHero} aria-labelledby="capture-heading">
          <div className={styles.heroCopy}>
            <span className={styles.heroTag}>
              <span />
              MADE FOR THE FIELD
            </span>
            <h2 id="capture-heading">
              Receipt in hand?
              <br />
              You’re almost done.
            </h2>
            <p>
              Take a clear photo. We’ll read the details
              <br className={styles.desktopBreak} /> and send it to your office for review.
            </p>
            <Link href="/field/new" className={styles.primary}>
              <Icon name="camera" size={21} />
              Add a receipt
              <Icon name="arrow" size={18} />
            </Link>
            <small>One receipt at a time · Up to 5 pages</small>
          </div>
          <div className={styles.heroArt} aria-hidden="true">
            <div className={styles.artCircle} />
            <div className={styles.paper}>
              <span className={styles.paperBrand}>SVL</span>
              <span className={styles.paperCaption}>RECEIPT</span>
              <div className={styles.paperRule} />
              <i />
              <i />
              <i />
              <div className={styles.paperRule} />
              <div className={styles.paperTotal}>
                <span>TOTAL</span>
                <span>•••.••</span>
              </div>
              <div className={styles.barcode} />
            </div>
            <div className={styles.sentStamp}>
              <span>
                <Icon name="check" size={18} />
              </span>
              Ready for review
            </div>
            <div className={styles.artSpark}>+</div>
          </div>
        </section>
      )}
      {draftError && <ApiNotice error={draftError} />}
      {drafts.length > 0 && (
        <section className={styles.draftPanel}>
          <div className={styles.sectionTitle}>
            <h2>
              <Icon name="clock" />
              Saved on this device <span className={styles.count}>{drafts.length}</span>
            </h2>
            <span>Not sent yet</span>
          </div>
          {drafts.map((draft) => (
            <Link className={styles.draftRow} href={`/field/new?draft=${draft.id}`} key={draft.id}>
              <span className={styles.rowIcon}>
                <Icon name="receipt" />
              </span>
              <span>
                <strong>{draft.started ? "Finish sending receipt" : "Receipt draft"}</strong>
                <small>
                  {draft.pages.length} {draft.pages.length === 1 ? "page" : "pages"} ·{" "}
                  {dateLabel(draft.createdAt)}
                </small>
              </span>
              <span className={styles.resume}>
                Resume <Icon name="arrow" size={18} />
              </span>
            </Link>
          ))}
        </section>
      )}
      {overview && (
        <section className={styles.stats} aria-label="Status of latest receipts">
          <div>
            <span className={styles.statIcon}>
              <Icon name="clock" />
            </span>
            <span>
              <strong>{loaded ? reviewing : "—"}</strong>
              <small>Sent & in review</small>
            </span>
          </div>
          <div>
            <span className={styles.statIcon} data-tone="green">
              <Icon name="check" />
            </span>
            <span>
              <strong>{loaded ? approved : "—"}</strong>
              <small>Approved</small>
            </span>
          </div>
          <div>
            <span className={styles.statIcon} data-tone="amber">
              <Icon name="camera" />
            </span>
            <span>
              <strong>{loaded ? retakes : "—"}</strong>
              <small>Need a retake</small>
            </span>
          </div>
          <p>Among your latest {receipts.length || 25} receipts</p>
        </section>
      )}
      <section className={styles.historyPanel}>
        <div className={styles.sectionTitle}>
          <h2>{overview ? "Recent receipts" : "Submitted receipts"}</h2>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.textButton}
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? "Refreshing…" : "Refresh"}
            </button>
            {overview && (
              <Link href="/field/receipts" className={styles.textLink}>
                View all <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
        </div>
        {!overview && (
          <nav className={styles.filters} aria-label="Filter receipts">
            {[
              ["all", "All receipts"],
              ["in_review", "In review"],
              ["approved", "Approved"],
              ["needs_retake", "Needs retake"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        {error && <ApiNotice error={error} />}
        {busy && !loaded ? (
          <div className={styles.empty} role="status">
            <Icon name="clock" size={30} />
            <h3>Loading your receipts…</h3>
          </div>
        ) : !error && visible.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="receipt" size={32} />
            </span>
            <h3>
              {filter === "all" ? "Your next receipt starts here" : "No receipts with this status"}
            </h3>
            <p>
              {filter === "all"
                ? "Once you send a receipt, you can follow its progress here."
                : "Try another filter or load older receipts."}
            </p>
            {filter === "all" && (
              <Link className={styles.textLink} href="/field/new">
                Add your first receipt <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
        ) : (
          <div className={styles.receiptRows}>
            {(overview ? visible.slice(0, 4) : visible).map((receipt) => (
              <Link
                key={receipt.id}
                href={`/field/receipts/${receipt.id}`}
                className={styles.receiptRow}
              >
                <div className={styles.thumbnail}>
                  {receipt.thumbnail ? (
                    // biome-ignore lint/performance/noImgElement: Private short-lived thumbnails must bypass the shared image cache.
                    <img
                      src={receipt.thumbnail.url}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <Icon name="receipt" />
                  )}
                </div>
                <div className={styles.receiptInfo}>
                  <strong>Receipt · {receipt.id.slice(0, 8).toUpperCase()}</strong>
                  <span>
                    {dateLabel(receipt.submittedAt)}
                    <b>·</b>
                    {receipt.pageCount} {receipt.pageCount === 1 ? "page" : "pages"}
                  </span>
                </div>
                <StatusBadge status={receipt.workerStatus} />
                <Icon name="arrow" size={18} />
              </Link>
            ))}
          </div>
        )}
        {!overview && cursor && (
          <button
            className={styles.loadMore}
            type="button"
            disabled={busy}
            onClick={() => void load(cursor)}
          >
            {busy ? "Loading…" : "Load older receipts"}
          </button>
        )}
      </section>
      {overview && (
        <div className={styles.bottomTip}>
          <Icon name="help" size={20} />
          <p>
            <strong>A clear photo goes a long way.</strong> Include all four corners, the total, and
            the date.
          </p>
          <Link href="/field/help">
            Photo tips <Icon name="arrow" size={16} />
          </Link>
        </div>
      )}
    </>
  );
}
