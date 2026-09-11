"use client";

import { RECEIPT_STATUSES } from "@svl/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  DEFAULT_QUEUE_FILTERS,
  HOUSECALL_STATUSES,
  QUEUE_TABS,
  type QueueFilters,
  type QueueReceipt,
  type QueueResponse,
} from "@/lib/manager/queue-contract";
import { Icon } from "./icons";
import styles from "./manager.module.css";
import {
  activeFilterCount,
  confidenceLabel,
  filtersFromSearch,
  money,
  queueSearch,
  receiptAge,
  STATUS_LABELS,
  TAB_DESCRIPTIONS,
  TAB_LABELS,
  warningLabel,
} from "./queue-view";
import { ManagerShell } from "./shell";

type LoadError = { kind: "auth" | "forbidden" | "request" | "network"; message: string };

export function ManagerDashboard({ actorRole }: { actorRole: "manager" | "admin" }) {
  const router = useRouter();
  const params = useSearchParams();
  const filters = filtersFromSearch(params);
  const cursor = params.get("cursor");
  const query = queueSearch(filters, cursor);
  const [snapshot, setSnapshot] = useState<{
    query: string;
    data: QueueResponse;
    loadedAt: number;
  } | null>(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<LoadError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(0);
  const [search, setSearch] = useState(filters.search);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previousCursors = useRef(new Map<string, string | null>());
  const data = snapshot?.query === query ? snapshot.data : null;
  const selected = data?.receipts.find((receipt) => receipt.id === selectedId) ?? null;
  const filterCount = activeFilterCount(filters);
  const hasFilters = filterCount > 0 || filters.search.length > 0;
  const stale = !!data && (!!failure || (now > 0 && now - (snapshot?.loadedAt ?? now) > 120_000));

  useEffect(() => setSearch(filters.search), [filters.search]);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") setRefresh((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the current URL without changing its filters.
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setFailure(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/manager/queue?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setSnapshot(null);
          setSelectedId(null);
          setFailure({
            kind: response.status === 401 ? "auth" : "forbidden",
            message:
              response.status === 401
                ? "Your session has ended. Sign in again to view receipts."
                : "Your account no longer has access to the manager queue.",
          });
          return;
        }
        if (!response.ok) {
          setFailure({
            kind: response.status === 400 ? "request" : "network",
            message:
              response.status === 400
                ? "These queue filters could not be used. Check the dates and submitter, or reset the filters."
                : "We couldn’t refresh the queue. Please try again.",
          });
          return;
        }
        const result = (await response.json()) as QueueResponse;
        if (controller.signal.aborted) return;
        setSnapshot({ query, data: result, loadedAt: Date.now() });
        setNow(Date.now());
      } catch {
        if (!controller.signal.aborted)
          setFailure({
            kind: "network",
            message: "We couldn’t reach the receipt service. Check your connection and try again.",
          });
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [query, refresh]);

  function navigate(
    nextFilters: QueueFilters,
    nextCursor: string | null = null,
    rememberCursor = false,
  ) {
    if (rememberCursor && nextCursor)
      previousCursors.current.set(queueSearch(nextFilters, nextCursor), cursor);
    setSelectedId(null);
    const nextQuery = queueSearch(nextFilters, nextCursor);
    router.push(nextQuery ? `/?${nextQuery}` : "/", { scroll: false });
  }

  function clearFilters() {
    navigate({
      ...DEFAULT_QUEUE_FILTERS,
      tab: filters.tab,
      sort: filters.sort,
      limit: filters.limit,
    });
    setFiltersOpen(false);
  }

  function searchQueue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...filters, search: search.trim() });
  }

  const isHistory =
    filters.tab === "history" ||
    filters.tab === "completed" ||
    filters.tab === "rejected-duplicate";
  const denied = failure?.kind === "auth" || failure?.kind === "forbidden";

  return (
    <ManagerShell actorRole={actorRole} active={isHistory ? "history" : "inbox"}>
      <main id="main-content" className={styles.main}>
        <div className={styles.pageHeading}>
          <div>
            <p className={styles.eyebrow}>RECEIPT WORKSPACE</p>
            <h1 className={styles.heading}>
              {isHistory ? "Receipt history" : "Receipt inbox"}
              <span className={styles.headingDot}>.</span>
            </h1>
            <p className={styles.subtitle}>
              {isHistory
                ? "A record of completed, rejected, and duplicate receipts."
                : "A little clarity for every receipt. Keep the day moving."}
            </p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setRefresh((value) => value + 1)}
            disabled={busy}
          >
            <Icon name="refresh" size={16} className={busy ? styles.spinning : undefined} />
            {busy && data ? "Refreshing…" : "Refresh queue"}
          </button>
        </div>

        {denied ? (
          <section className={styles.emptyState} role="alert">
            <span className={styles.emptyIcon}>
              <Icon name="settings" size={28} />
            </span>
            <h2>{failure.kind === "auth" ? "Sign in to continue" : "Manager access required"}</h2>
            <p>{failure.message}</p>
            {failure.kind === "auth" ? (
              <Link className={styles.primaryButton} href="/login">
                Sign in
              </Link>
            ) : (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setRefresh((value) => value + 1)}
              >
                Check access again
              </button>
            )}
          </section>
        ) : (
          <>
            <section className={styles.queueCard} aria-label="Receipt review queue">
              <div className={styles.queueHeading}>
                <div>
                  <span className={styles.sectionIcon}>
                    <Icon name="inbox" size={19} />
                  </span>
                  <h2>Review queue</h2>
                </div>
                <span className={styles.queueCaption}>FROM FIELD TO OFFICE</span>
              </div>
              <nav aria-label="Receipt status" className={styles.tabs}>
                {QUEUE_TABS.map((tab) => {
                  const href = queueSearch({ ...filters, tab });
                  return (
                    <Link
                      key={tab}
                      href={href ? `/?${href}` : "/"}
                      scroll={false}
                      aria-current={filters.tab === tab ? "page" : undefined}
                      className={filters.tab === tab ? styles.tabActive : undefined}
                      onClick={() => {
                        setSelectedId(null);
                      }}
                    >
                      <span className={`${styles.tabDot} ${styles[`dot_${tab}`]}`} />
                      {TAB_LABELS[tab]}
                    </Link>
                  );
                })}
              </nav>
              <div className={styles.toolbar}>
                <form className={styles.searchForm} onSubmit={searchQueue}>
                  <Icon name="search" size={18} />
                  <label htmlFor="receipt-search" className={styles.srOnly}>
                    Search vendor, reference, or receipt ID
                  </label>
                  <input
                    id="receipt-search"
                    name="search"
                    placeholder="Search vendor, reference, receipt ID…"
                    value={search}
                    maxLength={120}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <button type="submit" aria-label="Search receipts">
                    <Icon name="arrow" size={17} />
                  </button>
                </form>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${filtersOpen ? styles.filterActive : ""}`}
                  aria-expanded={filtersOpen}
                  aria-controls="queue-filters"
                  onClick={() => setFiltersOpen((value) => !value)}
                >
                  <Icon name="filter" size={16} />
                  Filters
                  {filterCount > 0 && <span className={styles.filterCount}>{filterCount}</span>}
                </button>
                <label className={styles.sortControl}>
                  <span className={styles.srOnly}>Sort receipts</span>
                  <Icon name="clock" size={16} />
                  <select
                    aria-label="Sort receipts"
                    value={filters.sort}
                    onChange={(event) =>
                      navigate({ ...filters, sort: event.target.value as QueueFilters["sort"] })
                    }
                  >
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                  </select>
                </label>
              </div>
              {filtersOpen && (
                <QueueFiltersPanel
                  key={queueSearch(filters)}
                  filters={filters}
                  receipts={data?.receipts ?? []}
                  onApply={(next) => {
                    navigate(next);
                    setFiltersOpen(false);
                  }}
                  onClear={clearFilters}
                />
              )}
              <div className={styles.queueDescription}>
                <p>{TAB_DESCRIPTIONS[filters.tab]}</p>
                {hasFilters && (
                  <button type="button" className={styles.textButton} onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </div>
              {filters.search && (
                <div className={styles.searchSummary}>
                  Search results for <strong>“{filters.search}”</strong>
                </div>
              )}
              <div aria-live="polite" aria-atomic="true" className={styles.srOnly}>
                {busy
                  ? "Loading receipts"
                  : data
                    ? `${data.receipts.length} receipts loaded. ${TAB_LABELS[filters.tab]}.`
                    : "Queue unavailable"}
              </div>

              {failure && (
                <div className={styles.errorBanner} role="alert">
                  <Icon name="warning" size={19} />
                  <p>
                    {failure.message}
                    {data && " Showing the last loaded results; they may be out of date."}
                  </p>
                  <button
                    type="button"
                    onClick={
                      failure.kind === "request"
                        ? clearFilters
                        : () => setRefresh((value) => value + 1)
                    }
                    disabled={busy}
                  >
                    {failure.kind === "request" ? "Reset filters" : "Try again"}
                  </button>
                </div>
              )}
              {stale && !failure && (
                <div className={styles.staleBanner} role="status">
                  <Icon name="clock" size={16} />
                  This queue was loaded over two minutes ago. Refresh for the latest status.
                </div>
              )}
              <div aria-busy={busy}>
                {!data && busy ? (
                  <QueueSkeleton />
                ) : data?.receipts.length ? (
                  <div className={styles.tableScroller}>
                    <table className={styles.receiptTable}>
                      <caption className={styles.srOnly}>
                        {TAB_LABELS[filters.tab]} receipts. Open a receipt for its summary and
                        warnings.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Receipt / reference total</th>
                          <th scope="col">Submitted by</th>
                          <th scope="col">Age</th>
                          <th scope="col">Top job suggestion</th>
                          <th scope="col">Field confidence</th>
                          <th scope="col">Signals</th>
                          <th scope="col">
                            <span className={styles.srOnly}>Open summary</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.receipts.map((receipt) => (
                          <ReceiptRow
                            key={`${receipt.id}-${snapshot?.loadedAt}`}
                            receipt={receipt}
                            asOf={now || new Date(data.asOf).getTime()}
                            onOpen={() => setSelectedId(receipt.id)}
                            onSubmitter={() =>
                              navigate({ ...filters, submitter: receipt.submitter.id })
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : !failure ? (
                  <section className={styles.emptyState}>
                    <span className={styles.emptyIcon}>
                      <Icon
                        name={
                          cursor
                            ? "receipt"
                            : hasFilters
                              ? "search"
                              : filters.tab === "needs-review"
                                ? "check"
                                : "receipt"
                        }
                        size={28}
                      />
                    </span>
                    <h3>
                      {cursor
                        ? "No more receipts on this page"
                        : hasFilters
                          ? "No receipts match these filters"
                          : filters.tab === "needs-review"
                            ? "You’re all caught up"
                            : `No ${TAB_LABELS[filters.tab].toLowerCase()} receipts`}
                    </h3>
                    <p>
                      {cursor
                        ? "Return to the first page to see the latest receipts in this queue."
                        : hasFilters
                          ? "Try another vendor, broaden the date range, or clear your filters."
                          : filters.tab === "needs-review"
                            ? "Receipts will appear here when they’re ready for a manager’s attention."
                            : "Receipts will appear here when they reach this stage."}
                    </p>
                    {cursor ? (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => navigate(filters)}
                      >
                        Back to first page
                      </button>
                    ) : (
                      hasFilters && (
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={clearFilters}
                        >
                          Clear filters
                        </button>
                      )
                    )}
                  </section>
                ) : (
                  !data && (
                    <section className={styles.emptyState}>
                      <span className={styles.emptyIcon}>
                        <Icon name="inbox" size={28} />
                      </span>
                      <h3>Queue unavailable</h3>
                      <p>Your filters are saved. Try loading the queue again.</p>
                    </section>
                  )
                )}
              </div>
              <footer className={styles.pagination}>
                <div className={styles.resultCount}>
                  {data ? (
                    <>
                      <strong>{data.receipts.length}</strong>{" "}
                      {data.receipts.length === 1 ? "receipt" : "receipts"} on this page
                    </>
                  ) : (
                    "Receipts"
                  )}
                  {data && (
                    <span className={styles.updatedLabel}>
                      {busy
                        ? "Refreshing…"
                        : stale
                          ? "May be out of date"
                          : now - (snapshot?.loadedAt ?? now) >= 60_000
                            ? "Updated a minute ago"
                            : "Updated just now"}
                    </span>
                  )}
                </div>
                <div className={styles.paginationControls}>
                  <label>
                    Rows{" "}
                    <select
                      aria-label="Receipts per page"
                      value={filters.limit}
                      onChange={(event) =>
                        navigate({ ...filters, limit: Number(event.target.value) })
                      }
                    >
                      {filters.limit !== 25 && filters.limit !== 50 && (
                        <option value={filters.limit}>{filters.limit}</option>
                      )}
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </label>
                  {cursor && (
                    <button
                      type="button"
                      className={styles.pageButton}
                      onClick={() => navigate(filters)}
                      disabled={busy}
                    >
                      First page
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.pageButton}
                    disabled={busy || !cursor || !previousCursors.current.has(query)}
                    onClick={() => {
                      const previous = previousCursors.current.get(query) ?? null;
                      navigate(filters, previous);
                    }}
                  >
                    <Icon name="chevron" size={15} style={{ transform: "rotate(180deg)" }} />
                    Previous
                  </button>
                  <button
                    type="button"
                    className={styles.pageButton}
                    disabled={busy || !data?.nextCursor}
                    onClick={() => navigate(filters, data?.nextCursor ?? null, true)}
                  >
                    Next
                    <Icon name="chevron" size={15} />
                  </button>
                </div>
              </footer>
            </section>
            <p className={styles.footnote}>
              <Icon name="receipt" size={14} />
              Reference totals come from extraction. Verify each receipt before making a review
              decision.
            </p>
          </>
        )}
        <ReceiptSummary receipt={selected} onClose={() => setSelectedId(null)} />
      </main>
    </ManagerShell>
  );
}

function QueueFiltersPanel({
  filters,
  receipts,
  onApply,
  onClear,
}: {
  filters: QueueFilters;
  receipts: QueueReceipt[];
  onApply: (filters: QueueFilters) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(filters);
  const submitters = new Map(
    receipts.map((receipt) => [receipt.submitter.id, receipt.submitter.label]),
  );
  if (draft.submitter && !submitters.has(draft.submitter))
    submitters.set(draft.submitter, `Worker ${draft.submitter.slice(0, 8)}`);
  const field = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <form
      id="queue-filters"
      className={styles.filterPanel}
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ ...draft, vendor: draft.vendor.trim() });
      }}
    >
      <div className={styles.filterGrid}>
        <label>
          Review / export state
          <select
            value={draft.status}
            onChange={(event) => field("status", event.target.value as QueueFilters["status"])}
          >
            <option value="all">All states in this tab</option>
            {RECEIPT_STATUSES.filter((status) => status !== "upload_pending").map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Receipt age
          <select
            value={draft.age}
            onChange={(event) => field("age", event.target.value as QueueFilters["age"])}
          >
            <option value="all">Any age</option>
            <option value="over-24h">Older than 24 hours</option>
            <option value="over-7d">Older than 7 days</option>
            <option value="over-30d">Older than 30 days</option>
          </select>
        </label>
        <label>
          Submitter
          <select
            value={draft.submitter}
            onChange={(event) => field("submitter", event.target.value)}
          >
            <option value="">All submitters</option>
            {[...submitters].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <small>Available submitters on this page</small>
        </label>
        <label>
          Vendor
          <input
            value={draft.vendor}
            maxLength={120}
            placeholder="Vendor name contains…"
            onChange={(event) => field("vendor", event.target.value)}
          />
        </label>
        <label>
          Field confidence
          <select
            value={draft.confidence}
            onChange={(event) =>
              field("confidence", event.target.value as QueueFilters["confidence"])
            }
          >
            <option value="all">Any confidence</option>
            <option value="low">Low · below 80%</option>
            <option value="high">High · 80% or above</option>
            <option value="unknown">Unavailable</option>
          </select>
        </label>
        <label>
          Duplicate flag
          <select
            value={draft.duplicate}
            onChange={(event) =>
              field("duplicate", event.target.value as QueueFilters["duplicate"])
            }
          >
            <option value="all">Any duplicate flag</option>
            <option value="marked">Marked duplicate</option>
            <option value="unmarked">Not marked duplicate</option>
          </select>
        </label>
        <label>
          Housecall status
          <select
            value={draft.housecall}
            onChange={(event) =>
              field("housecall", event.target.value as QueueFilters["housecall"])
            }
          >
            <option value="all">Any Housecall status</option>
            {HOUSECALL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.dateRange}>
          <label>
            Submitted from (UTC)
            <input
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => field("from", event.target.value)}
            />
          </label>
          <label>
            Submitted to (UTC)
            <input
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => field("to", event.target.value)}
            />
          </label>
        </div>
      </div>
      <div className={styles.filterFooter}>
        <p>Filters apply within the selected tab. Confidence reflects extracted fields.</p>
        <div>
          <button type="button" className={styles.textButton} onClick={onClear}>
            Reset
          </button>
          <button type="submit" className={styles.primaryButton}>
            Apply filters <Icon name="arrow" size={15} />
          </button>
        </div>
      </div>
    </form>
  );
}

function ReceiptThumbnail({ receipt, large = false }: { receipt: QueueReceipt; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`${styles.thumbnail} ${large ? styles.thumbnailLarge : ""}`}>
      {receipt.thumbnailUrl && !failed ? (
        // biome-ignore lint/performance/noImgElement: this authenticated thumbnail endpoint downsizes images; the Next optimizer would strip cookies and alter private caching.
        <img
          src={receipt.thumbnailUrl}
          alt="Receipt first page"
          width={large ? 160 : 38}
          height={large ? 210 : 48}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name="receipt" size={large ? 36 : 22} />
      )}
      {receipt.pageCount > 1 && <span className={styles.pageCount}>{receipt.pageCount}</span>}
    </span>
  );
}

function ReceiptRow({
  receipt,
  asOf,
  onOpen,
  onSubmitter,
}: {
  receipt: QueueReceipt;
  asOf: number;
  onOpen: () => void;
  onSubmitter: () => void;
}) {
  const vendor = receipt.vendor || "Vendor unavailable";
  const confidence = confidenceLabel(receipt.confidence);
  const old = asOf - new Date(receipt.submittedAt).getTime() > 7 * 86_400_000;
  return (
    <tr>
      <td className={styles.receiptCell}>
        <div className={styles.receiptIdentity}>
          <ReceiptThumbnail receipt={receipt} />
          <div>
            <button type="button" className={styles.receiptTitle} onClick={onOpen}>
              {vendor}
            </button>
            <div className={styles.receiptReference}>
              {receipt.reference ? receipt.reference : `Receipt ${receipt.id.slice(0, 8)}`}
            </div>
            <strong className={styles.receiptTotal}>{money(receipt.referenceTotalCents)}</strong>
          </div>
        </div>
      </td>
      <td data-label="Submitted by">
        <button
          type="button"
          className={styles.submitterButton}
          onClick={onSubmitter}
          title={`Filter receipts by ${receipt.submitter.label}`}
        >
          {receipt.submitter.label}
        </button>
        <span className={styles.secondaryText}>{STATUS_LABELS[receipt.status]}</span>
      </td>
      <td data-label="Age">
        <time
          className={old ? styles.oldAge : undefined}
          dateTime={receipt.submittedAt}
          title={new Date(receipt.submittedAt).toLocaleString()}
        >
          {receiptAge(receipt.submittedAt, asOf)}
        </time>
      </td>
      <td data-label="Job assignment / suggestion">
        <span className={receipt.suggestedJob ? styles.jobLabel : styles.unavailable}>
          {receipt.assignedJobs?.length
            ? receipt.assignedJobs.map((job) => job.label || job.id).join(" · ")
            : receipt.suggestedJob
              ? receipt.suggestedJob.label || `Job ${receipt.suggestedJob.id}`
              : "No suggestion yet"}
        </span>
        <span className={styles.secondaryText}>
          {receipt.assignedJobs?.length
            ? `${receipt.assignedJobs.length} assigned jobs · ${receipt.assignedJobs.map((job) => job.id).join(", ")}`
            : receipt.suggestedJob
              ? "Stored suggestion · ranking unavailable"
              : "Job match unavailable"}
        </span>
      </td>
      <td data-label="Field confidence">
        <span
          className={`${styles.confidenceBadge} ${confidence === "Low confidence" ? styles.confidenceLow : confidence === "High confidence" ? styles.confidenceHigh : styles.confidenceUnknown}`}
        >
          <span />
          {confidence === "Low confidence"
            ? "Low"
            : confidence === "High confidence"
              ? "High"
              : "Unavailable"}
          {receipt.confidence !== null &&
            Number.isFinite(receipt.confidence) &&
            receipt.confidence >= 0 &&
            receipt.confidence <= 1 && (
              <span className={styles.confidenceValue}>
                {Math.round(receipt.confidence * 100)}%
              </span>
            )}
        </span>
      </td>
      <td data-label="Signals">
        {receipt.warnings.length > 0 ? (
          <button
            type="button"
            className={styles.signalButton}
            onClick={onOpen}
            aria-label={`${receipt.warnings.length} warnings for ${vendor}: ${receipt.warnings.map(warningLabel).join(", ")}`}
          >
            <Icon name="warning" size={16} />
            <span>{receipt.warnings.length}</span>
          </button>
        ) : (
          <span className={styles.unavailable}>
            <span aria-hidden="true">—</span>
            <span className={styles.srOnly}>No warnings recorded</span>
          </span>
        )}
      </td>
      <td className={styles.openCell}>
        <button
          type="button"
          className={styles.openButton}
          onClick={onOpen}
          aria-label={`Open receipt summary for ${vendor}`}
        >
          <Icon name="chevron" size={18} />
        </button>
      </td>
    </tr>
  );
}

function QueueSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row}>
          <span />
          <i />
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>
  );
}

function ReceiptSummary({
  receipt,
  onClose,
}: {
  receipt: QueueReceipt | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (receipt && !ref.current?.open) ref.current?.showModal();
    if (!receipt && ref.current?.open) ref.current?.close();
  }, [receipt]);
  return (
    <dialog
      ref={ref}
      className={styles.receiptDialog}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="receipt-summary-title"
    >
      {receipt && (
        <>
          <div className={styles.dialogHeader}>
            <div>
              <p className={styles.eyebrow}>RECEIPT SUMMARY</p>
              <h2 id="receipt-summary-title">{receipt.vendor || "Vendor unavailable"}</h2>
            </div>
            <button
              type="button"
              className={styles.openButton}
              onClick={onClose}
              aria-label="Close receipt summary"
            >
              <Icon name="close" />
            </button>
          </div>
          <div className={styles.dialogBody}>
            <Link
              className={`${styles.primaryButton} ${styles.fullReviewButton}`}
              href={`/receipts/${receipt.id}`}
            >
              Open full receipt review <Icon name="chevron" size={16} />
            </Link>
            <div className={styles.summaryHero}>
              <ReceiptThumbnail key={receipt.id} receipt={receipt} large />
              <div>
                <span className={styles.summaryStatus}>{STATUS_LABELS[receipt.status]}</span>
                <p className={styles.summaryTotal}>{money(receipt.referenceTotalCents)}</p>
                <p className={styles.secondaryText}>
                  Reference total · {receipt.pageCount} {receipt.pageCount === 1 ? "page" : "pages"}
                </p>
                <p className={styles.summaryReference}>
                  {receipt.reference || "Reference unavailable"}
                </p>
              </div>
            </div>
            <dl className={styles.detailGrid}>
              <div>
                <dt>Submitted by</dt>
                <dd>{receipt.submitter.label}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{new Date(receipt.submittedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Housecall export</dt>
                <dd>{STATUS_LABELS[receipt.housecallStatus]}</dd>
              </div>
              <div>
                <dt>Field confidence</dt>
                <dd>
                  {confidenceLabel(receipt.confidence)}
                  {receipt.confidence !== null && ` · ${Math.round(receipt.confidence * 100)}%`}
                </dd>
              </div>
              <div>
                <dt>Stored job suggestion</dt>
                <dd>
                  {receipt.suggestedJob
                    ? receipt.suggestedJob.label || `Job ${receipt.suggestedJob.id}`
                    : "Unavailable"}
                </dd>
                {receipt.suggestedJob && (
                  <p className={styles.secondaryText}>Suggestion ranking is unavailable.</p>
                )}
              </div>
              <div>
                <dt>Duplicate flag</dt>
                <dd>
                  {receipt.duplicate === "marked" ? "Marked duplicate" : "Not marked duplicate"}
                </dd>
              </div>
              <div className={styles.fullWidth}>
                <dt>Receipt ID</dt>
                <dd className={styles.monospace}>{receipt.id}</dd>
              </div>
            </dl>
            {receipt.warnings.length > 0 && (
              <section className={styles.warningList}>
                <h3>
                  <Icon name="warning" size={17} />
                  Items to check
                </h3>
                <ul>
                  {receipt.warnings.map((warning) => (
                    <li key={warning}>{warningLabel(warning)}</li>
                  ))}
                </ul>
              </section>
            )}
            <p className={styles.summaryNote}>
              This is a read-only queue summary. Receipt editing, job assignment, and review
              decisions are not available here.
            </p>
          </div>
          <div className={styles.dialogFooter}>
            <button type="button" className={styles.primaryButton} onClick={onClose}>
              Back to queue
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
