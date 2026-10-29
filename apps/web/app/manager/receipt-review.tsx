"use client";
import {
  decimalUnits,
  lineCostCents,
  type ReceiptCategory,
  type ReviewDraft,
  type ReviewLine,
  receiptTypeLabel,
  reviewSummary,
  validateReview,
} from "@svl/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { jobLabel, jobMetadata } from "@/lib/manager/presentation";
import type {
  ExportStep,
  ManagerJob,
  ReceiptDetail,
  ReviewEvent,
} from "@/lib/manager/review-contract";
import { ExtractionEvidence } from "./extraction-evidence";
import { ExtractionNotes } from "./extraction-notes";
import { HousecallPreview } from "./housecall-preview";
import { money } from "./queue-view";
import styles from "./receipt-review.module.css";
import { ManagerShell } from "./shell";

const labels = {
  vendor: "Vendor",
  purchaseDate: "Purchase date",
  invoiceNumber: "Invoice number",
  ticketNumber: "Ticket number",
  category: "Category",
  referenceTotal: "Receipt total (reference only)",
  managerNotes: "Manager notes",
};
const sourceKeys = {
  vendor: "vendor",
  purchaseDate: "purchase_date",
  invoiceNumber: "invoice_number",
  ticketNumber: "ticket_number",
  category: "category",
  referenceTotal: "receipt_total_cents",
  managerNotes: "manager_notes",
};
const lineLabels = {
  description: "Description",
  qty: "Quantity",
  uom: "UOM",
  unitCost: "Unit cost",
};
const emptyLine = (): ReviewLine => ({
  id: crypto.randomUUID(),
  description: "",
  qty: "1",
  uom: "",
  unitCost: "",
  jobId: "",
});
const nice = (text: string) => text.replaceAll("_", " ");
function sourceLineText(detail: ReceiptDetail, line: ReviewLine) {
  const original =
    (line.id ? detail.lineEvidence?.[line.id] : undefined) ??
    (line.sourceIndex === undefined
      ? undefined
      : detail.original.lines.find((item) => item.sourceIndex === line.sourceIndex));
  return original
    ? `${original.description} · ${original.qty} × ${original.unitCost}`
    : "No line mapping to this extraction";
}
export function ReceiptReview({ id, actorRole }: { id: string; actorRole: "manager" | "admin" }) {
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [canonical, setCanonical] = useState("");
  const proposedCanonical = useRef("");
  const [tax, setTax] = useState(false);
  const [correction, setCorrection] = useState(false);
  const [jobs, setJobs] = useState<ManagerJob[]>([]);
  const [selectedJobs, setSelectedJobs] = useState<ManagerJob[]>([]);
  const [jobSearch, setJobSearch] = useState("");
  const [jobResultsQuery, setJobResultsQuery] = useState<string | null>(null);
  const [searchingJobs, setSearchingJobs] = useState(true);
  const [showJobResults, setShowJobResults] = useState(false);
  const [bulkJobId, setBulkJobId] = useState("");
  const [olderJobs, setOlderJobs] = useState(true);
  const [jobError, setJobError] = useState("");
  const [jobRefreshError, setJobRefreshError] = useState("");
  const [refreshingJobs, setRefreshingJobs] = useState(false);
  const [refreshingCategories, setRefreshingCategories] = useState(false);
  const [categoryError, setCategoryError] = useState("");
  const [categoryMessage, setCategoryMessage] = useState("");
  const [jobRefreshVersion, setJobRefreshVersion] = useState(0);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  const [retry, setRetry] = useState<ExportStep | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const actionLock = useRef(false);
  const loadSequence = useRef(0);
  const jobRefreshLock = useRef(false);
  const automaticJobRefresh = useRef<string | null>(null);
  const selectedJobIdsRef = useRef<string[]>([]);
  selectedJobIdsRef.current = [
    ...new Set(draft?.lines.map((line) => line.jobId).filter(Boolean) ?? []),
  ];
  const pendingLineFocus = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = !!draft && !!detail && JSON.stringify(draft) !== JSON.stringify(detail.draft);
  const editable = !!detail && (detail.editable || correction);
  const summary = draft ? reviewSummary(draft) : null;
  const pendingExport =
    !!detail &&
    ["approved", "exporting", "partial_success", "export_failed"].includes(detail.status) &&
    detail.steps.some((step) => ["ready", "pending", "in_progress"].includes(step.status));
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/manager/receipts/${id}`, { cache: "no-store" });
      if (sequence !== loadSequence.current) return;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setDetail(null);
          setDraft(null);
        }
        throw new Error(
          res.status === 401
            ? "Your session ended. Sign in again."
            : res.status === 403
              ? "Manager access is required."
              : res.status === 404
                ? "Receipt content is no longer available."
                : "Could not load this receipt. Try again.",
        );
      }
      const data: ReceiptDetail = await res.json();
      if (sequence !== loadSequence.current) return;
      setDetail(data);
      setDraft(data.draft);
      setEvents(data.events);
      setEventCursor(data.nextEventCursor);
      setCorrection(false);
      setErrors({});
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "Could not load receipt.");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    setDetail(null);
    setDraft(null);
    setSelectedJobs([]);
    setBulkJobId("");
    setShowJobResults(false);
    setJobRefreshError("");
    automaticJobRefresh.current = null;
    void load();
    return () => {
      loadSequence.current++;
    };
  }, [load]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    if (
      !detail ||
      (!["approved", "exporting"].includes(detail.status) && !pendingExport) ||
      dirty ||
      correction ||
      action ||
      busy ||
      loading
    )
      return;
    const timer = setTimeout(() => {
      void load();
    }, 4000);
    return () => clearTimeout(timer);
  }, [detail, dirty, correction, action, busy, loading, load, pendingExport]);
  useEffect(() => {
    if (action) {
      dialog.current?.showModal();
      setReason("");
      setCanonical(proposedCanonical.current);
      proposedCanonical.current = "";
      setTax(false);
    } else dialog.current?.close();
  }, [action]);
  useEffect(() => {
    if (pendingLineFocus.current) {
      form.current
        ?.querySelector<HTMLInputElement>(
          `[name="line-${(draft?.lines.length ?? 1) - 1}-description"]`,
        )
        ?.focus();
      pendingLineFocus.current = false;
    }
  }, [draft?.lines.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The explicit refresh version reloads the current search after a provider sync.
  useEffect(() => {
    const controller = new AbortController();
    setSearchingJobs(true);
    setJobError("");
    const query = `${olderJobs}:${jobSearch.trim()}`;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/manager/jobs?search=${encodeURIComponent(jobSearch)}&scope=${olderJobs ? "all" : "active"}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!controller.signal.aborted) {
          setJobs(data.jobs);
          setJobResultsQuery(query);
          setSelectedJobs((current) =>
            current.map(
              (selected) => data.jobs.find((job: ManagerJob) => job.id === selected.id) ?? selected,
            ),
          );
        }
      } catch {
        if (!controller.signal.aborted) {
          setJobResultsQuery(query);
          setJobs([]);
          setJobError("Job search is unavailable. Existing selections are preserved.");
        }
      } finally {
        if (!controller.signal.aborted) setSearchingJobs(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [jobSearch, olderJobs, jobRefreshVersion]);
  async function refreshCategories() {
    if (refreshingCategories) return;
    const sequence = loadSequence.current;
    setRefreshingCategories(true);
    setCategoryError("");
    setCategoryMessage("");
    try {
      const response = await fetch("/api/manager/categories", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result: { categories: ReceiptCategory[] } = await response.json();
      if (!Array.isArray(result.categories)) throw new Error();
      if (sequence !== loadSequence.current) return;
      // Only replace the catalog. Never reload the receipt or discard a draft.
      setDetail((current) => (current ? { ...current, categories: result.categories } : current));
      setCategoryMessage(
        result.categories.some((category) => category.active)
          ? "Categories refreshed. Your receipt edits are preserved."
          : "No active categories are available yet. Contact an administrator.",
      );
    } catch {
      if (sequence === loadSequence.current)
        setCategoryError(
          "Could not refresh categories. Your receipt edits are preserved. Try again.",
        );
    } finally {
      setRefreshingCategories(false);
    }
  }
  const refreshJobs = useCallback(async () => {
    if (jobRefreshLock.current) return;
    jobRefreshLock.current = true;
    const sequence = loadSequence.current;
    setRefreshingJobs(true);
    setJobRefreshError("");
    try {
      const response = await fetch("/api/manager/jobs", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error?.message || "Housecall jobs could not be refreshed. Try again shortly.",
        );
      if (result.skipped)
        throw new Error(
          result.skipped === "sync_in_progress"
            ? "Another Housecall refresh is in progress. Try again shortly."
            : "Housecall job refresh is unavailable.",
        );
      const selectedIds = selectedJobIdsRef.current;
      if (selectedIds.length) {
        const selectedResponse = await fetch(
          `/api/manager/jobs?ids=${encodeURIComponent(selectedIds.join(","))}`,
          { cache: "no-store" },
        );
        if (!selectedResponse.ok)
          throw new Error(
            "Jobs refreshed, but selected job details could not be loaded. Try refreshing again.",
          );
        const selectedResult: { jobs: ManagerJob[] } = await selectedResponse.json();
        if (sequence !== loadSequence.current) return;
        setSelectedJobs((current) =>
          current.map((job) => selectedResult.jobs.find((fresh) => fresh.id === job.id) ?? job),
        );
      }
      const detailsResponse = await fetch(`/api/manager/receipts/${id}`, { cache: "no-store" });
      if (!detailsResponse.ok)
        throw new Error(
          "Jobs refreshed, but receipt job details could not be loaded. Try refreshing again.",
        );
      const fresh: ReceiptDetail = await detailsResponse.json();
      if (sequence !== loadSequence.current) return;
      setDetail((current) =>
        current
          ? { ...current, assignedJobs: fresh.assignedJobs, suggestions: fresh.suggestions }
          : current,
      );
      setJobRefreshVersion((value) => value + 1);
    } catch (error) {
      if (sequence === loadSequence.current)
        setJobRefreshError(
          `${error instanceof Error ? error.message : "Jobs could not be refreshed."} Your receipt edits are preserved.`,
        );
    } finally {
      jobRefreshLock.current = false;
      setRefreshingJobs(false);
    }
  }, [id]);
  useEffect(() => {
    if (!detail?.editable || automaticJobRefresh.current === id || jobRefreshLock.current) return;
    if (![...jobs, ...(detail.assignedJobs ?? []), ...detail.suggestions].some((job) => job.stale))
      return;
    automaticJobRefresh.current = id;
    void refreshJobs();
  }, [detail, jobs, id, refreshJobs]);
  async function intelligenceAction(path: string, payload?: Record<string, unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/manager/receipts/${id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok)
        throw new Error(
          path === "reextract"
            ? "Could not queue extraction. The receipt may already be processing or approved."
            : "Could not dismiss this candidate.",
        );
      if (path === "duplicates")
        setDetail((current) =>
          current
            ? {
                ...current,
                duplicates: current.duplicates?.map((candidate) =>
                  candidate.id === payload?.candidateId
                    ? { ...candidate, status: "dismissed" }
                    : candidate,
                ),
              }
            : current,
        );
      else await load();
      setMessage(
        path === "reextract"
          ? "A new extraction was queued. Saved manager edits remain in review history."
          : "Candidate dismissed; approval is not blocked by this candidate.",
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not apply action.");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function updateLine(index: number, patch: Partial<ReviewLine>) {
    setDraft((d) =>
      d
        ? { ...d, lines: d.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) }
        : d,
    );
  }
  function prepare(decision: string) {
    if (!draft) return;
    const next = validateReview(draft, decision === "approve");
    if (decision === "approve")
      draft.lines.forEach((line, index) => {
        if (decimalUnits(line.qty, 3) !== 0 && allJobs.find((job) => job.id === line.jobId)?.stale)
          next[`lines.${index}.jobId`] =
            "Refresh Housecall jobs before approving this destination.";
        if (
          decimalUnits(line.qty, 3) !== 0 &&
          allJobs.find((job) => job.id === line.jobId)?.unavailable
        )
          next[`lines.${index}.jobId`] =
            "This Housecall job is unavailable. Choose an available job.";
      });
    setErrors(next);
    if (Object.keys(next).length) {
      setError("Resolve the highlighted fields.");
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setError("");
    if (decision === "save_draft") void submit(decision);
    else setAction(decision);
  }
  async function submit(decision: string) {
    if (!detail || !draft || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const recovery = decision === "retry" || decision === "correction";
      const payload = recovery
        ? {
            kind: decision,
            intentId: retry?.intentId ?? detail.steps[0]?.intentId,
            attemptId: retry?.id,
            reason,
            draft,
            confirmImpact: tax,
          }
        : {
            decision,
            version: detail.version,
            extractionId: detail.extractionId,
            draft,
            reason,
            canonicalReceiptId: decision === "mark_duplicate" ? canonical : null,
            taxExcluded: tax,
          };
      const res = await fetch(`/api/manager/receipts/${id}/${recovery ? "recovery" : "review"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.fields) setErrors(body.fields);
        throw new Error(
          res.status === 409 && (!body.error?.code || body.error.code === "conflict")
            ? "This receipt changed since you opened it. Your edits are preserved. Reload the latest receipt before saving again."
            : res.status === 401
              ? "Your session ended. Sign in again."
              : body.error?.message || "The action could not be saved. Try again.",
        );
      }
      setAction(null);
      await load();
      setMessage(
        body.message ||
          (decision === "save_draft"
            ? "Draft saved."
            : decision === "approve"
              ? body.exportAuthorized
                ? "Receipt approved. Sending the receipt and material costs to the selected Housecall jobs. Check export status below for confirmation."
                : "Receipt approved. Export is prepared; live Housecall writes require separate explicit approval."
              : decision === "request_clarification"
                ? "Clarification recorded. Contact the worker using your agreed channel."
                : "Decision recorded."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function applyJob(job: ManagerJob) {
    if (!draft || job.unavailable) return;
    if (
      draft.lines.some((l) => l.jobId && l.jobId !== job.id) &&
      !window.confirm("Replace the existing job assignments on every line?")
    )
      return;
    setDraft({
      ...draft,
      lines: draft.lines.map((l) => ({
        ...l,
        jobId: job.id,
        suggestionId: job.suggestionId,
      })),
    });
    setBulkJobId(job.id);
    setShowJobResults(false);
    setSelectedJobs((current) => [job, ...current.filter((selected) => selected.id !== job.id)]);
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !/^lines\.\d+\.jobId$/.test(key)),
      ),
    );
    setMessage(
      `Assigned ${jobLabel(job)} to all ${draft.lines.length} materials. Save or approve to keep these assignments.`,
    );
  }
  async function continueExport() {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/manager/receipts/${id}/export-continue`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error?.message || "Could not continue Housecall export. Try again.");
      await load();
      setMessage(body.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not continue Housecall export.");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function moreEvents() {
    if (!eventCursor || eventBusy) return;
    setEventBusy(true);
    try {
      const res = await fetch(
        `/api/manager/receipts/${id}/events?cursor=${encodeURIComponent(eventCursor)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      setEvents((e) => [...e, ...data.events]);
      setEventCursor(data.nextCursor);
    } catch {
      setError("Could not load more audit events. Try again.");
    } finally {
      setEventBusy(false);
    }
  }
  const allJobs = [
    ...(detail?.suggestions ?? []).map((suggestion) => ({
      ...suggestion,
      ...selectedJobs.find((job) => job.id === suggestion.id),
      ...detail?.assignedJobs?.find((job) => job.id === suggestion.id),
      ...jobs.find((job) => job.id === suggestion.id),
      suggestionId: suggestion.suggestionId,
    })),
    ...jobs,
    ...(detail?.assignedJobs ?? []),
    ...selectedJobs,
  ].filter((j, i, rows) => rows.findIndex((x) => x.id === j.id) === i);
  const matchingJobQuery = jobResultsQuery === `${olderJobs}:${jobSearch.trim()}`;
  const jobResultsLoading = searchingJobs || !matchingJobQuery;
  return (
    <ManagerShell actorRole={actorRole} active={detail?.editable ? "inbox" : "history"}>
      <main id="main-content" className={styles.main}>
        <div className={styles.heading}>
          <div>
            <Link
              href="/"
              onClick={(e) => {
                if (dirty && !window.confirm("Leave without saving your edits?"))
                  e.preventDefault();
              }}
            >
              ← Receipt queue
            </Link>
            <h1>{detail?.draft.vendor || "Receipt review"}</h1>
            <p className={styles.meta}>
              {id} · {detail ? nice(detail.status) : "Loading"}
            </p>
          </div>
          <button
            type="button"
            disabled={loading || busy}
            onClick={() => {
              if (!dirty || window.confirm("Discard your edits and reload the latest receipt?"))
                void load();
            }}
          >
            Reload latest receipt
          </button>
        </div>
        {error && !action && (
          <div role="alert" className={styles.error}>
            {error}
            {error.includes("session") && (
              <>
                {" "}
                <Link href="/login">Sign in</Link>
              </>
            )}
          </div>
        )}
        {message && (
          <p role="status" className={styles.notice}>
            {message}
          </p>
        )}
        {loading && !detail && <p role="status">Loading receipt…</p>}
        {detail && draft && (
          <>
            {!editable && (
              <p className={styles.notice}>
                Historical receipt · Read-only. Review version {detail.version}.
              </p>
            )}
            {detail.clarification && (
              <p className={styles.notice}>Clarification requested: {detail.clarification}</p>
            )}
            {detail.canonicalReceiptId && (
              <p>
                Duplicate of{" "}
                <Link href={`/receipts/${detail.canonicalReceiptId}`}>
                  {detail.canonicalReceiptId}
                </Link>
              </p>
            )}
            {correction && (
              <p className={styles.notice}>
                Correction proposal · Posted records remain unchanged until an administrator
                reconciles the external impact.
              </p>
            )}
            <div className={styles.twoPane}>
              <section className={styles.imagePane} aria-label="Original receipt">
                <ReceiptPages key={id} id={id} pageCount={detail.pageCount} />
                <p>
                  {detail.gps
                    ? `Location available · ${detail.gps.lat.toFixed(4)}, ${detail.gps.lng.toFixed(4)}`
                    : "No location was shared with this receipt."}
                </p>
              </section>
              <form
                ref={form}
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  prepare("save_draft");
                }}
              >
                <h2>Receipt details</h2>
                {detail.reprocessed && (
                  <p className={styles.notice}>
                    A newer extraction is available. Your saved edits and original line evidence are
                    retained; job suggestions from prior extraction versions have been cleared.
                  </p>
                )}
                {detail.extractionId && (
                  <ExtractionEvidence
                    key={detail.extractionId}
                    receiptId={id}
                    extractionId={detail.extractionId}
                  />
                )}
                {detail.emailSource && (
                  <section className={styles.intelligencePanel} aria-label="Email source">
                    <h3>Emailed receipt</h3>
                    <p>{detail.emailSource.filename} · recisvl@gmail.com</p>
                    <a href={`/api/manager/email-imports/${detail.emailSource.importId}/original`}>
                      Download original email
                    </a>
                  </section>
                )}
                <ExtractionNotes warnings={detail.warnings ?? []} editable={editable} />
                {!!detail.duplicates?.length && (
                  <section className={styles.intelligencePanel} aria-label="Duplicate candidates">
                    <h3>Possible duplicates</h3>
                    <p>
                      Compare the originals and resolve each possible duplicate before approval.
                      Mark repeated purchases as duplicates; dismiss a match only when it is a
                      separate purchase.
                    </p>
                    {detail.duplicates.map((candidate) => (
                      <div key={candidate.id}>
                        <Link href={`/receipts/${candidate.receiptId}`}>Compare receipt</Link> ·
                        Evidence score {candidate.score} · {candidate.status}
                        <ul>
                          {candidate.reasons.map((reason) => (
                            <li key={reason.code}>{reason.message}</li>
                          ))}
                        </ul>
                        {candidate.status === "pending" && detail.editable && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                proposedCanonical.current = candidate.receiptId;
                                prepare("mark_duplicate");
                              }}
                            >
                              Review as duplicate
                            </button>{" "}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void intelligenceAction("duplicates", {
                                  decision: "dismiss",
                                  candidateId: candidate.id,
                                })
                              }
                            >
                              Dismiss candidate
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </section>
                )}
                {(detail.status === "needs_review" || detail.status === "failed") && (
                  <p>
                    <button
                      type="button"
                      disabled={busy || dirty}
                      onClick={() => void intelligenceAction("reextract")}
                    >
                      Run extraction again
                    </button>{" "}
                    {dirty
                      ? "Save your edits before reprocessing."
                      : "Creates a new extraction version; saved manager edits stay authoritative."}
                  </p>
                )}
                <div className={styles.fields}>
                  {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => (
                    <div key={key} className={key === "managerNotes" ? styles.full : undefined}>
                      <label htmlFor={key}>
                        {labels[key]}
                        {["vendor", "purchaseDate", "category"].includes(key) && " *"}
                      </label>
                      {key === "category" && detail.categories ? (
                        <select
                          id={key}
                          value={draft.category}
                          disabled={!editable || busy}
                          aria-invalid={!!errors[key]}
                          onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                        >
                          <option value="">Select an approved category</option>
                          {draft.category &&
                            !detail.categories.some(
                              (category) => category.id === draft.category,
                            ) && (
                              <option value={draft.category}>{draft.category} (historical)</option>
                            )}
                          {detail.categories
                            .filter((category) => category.active || category.id === draft.category)
                            .map((category) => (
                              <option
                                key={category.id}
                                value={category.id}
                                disabled={!category.active}
                              >
                                {category.label}
                                {category.active ? "" : " (inactive)"}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <input
                          id={key}
                          type={key === "purchaseDate" ? "date" : "text"}
                          inputMode={key === "referenceTotal" ? "decimal" : undefined}
                          value={draft[key]}
                          disabled={!editable || busy}
                          maxLength={key === "managerNotes" ? 2000 : 200}
                          aria-invalid={!!errors[key]}
                          aria-describedby={errors[key] ? `${key}-error` : undefined}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        />
                      )}
                      {key === "category" &&
                        detail.categories &&
                        !detail.categories.some((category) => category.active) && (
                          <small>
                            No approved active categories are configured. Ask an administrator to
                            configure them.
                          </small>
                        )}
                      {key === "category" && editable && (
                        <div>
                          <button
                            type="button"
                            disabled={busy || refreshingCategories}
                            onClick={() => void refreshCategories()}
                          >
                            {refreshingCategories ? "Refreshing categories…" : "Refresh categories"}
                          </button>
                          {categoryError && <small role="alert">{categoryError}</small>}
                          {categoryMessage && <small role="status">{categoryMessage}</small>}
                        </div>
                      )}
                      {key === "category" &&
                        detail.categorySuggestion?.reasons.map((reason) => (
                          <small key={reason.code}>{reason.message}</small>
                        ))}
                      {errors[key] && (
                        <small id={`${key}-error`} className={styles.fieldError}>
                          {errors[key]}
                        </small>
                      )}
                      {key !== "managerNotes" && (
                        <details>
                          <summary>
                            {draft[key] !== detail.original[key]
                              ? "Edited"
                              : (detail.confidence[sourceKeys[key]] ?? 0) < 0.8
                                ? "Review evidence"
                                : "Suggested"}
                          </summary>
                          <p>Extracted: {detail.original[key] || "Not available"}</p>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
                <div className={styles.sectionHeading}>
                  <h2>Materials</h2>
                  <span>
                    {summary?.lineCount} lines · {summary?.jobCount} jobs
                  </span>
                </div>
                <div>
                  <label htmlFor="receipt-type">Receipt type *</label>
                  <select
                    id="receipt-type"
                    data-receipt-type={draft.receiptType ?? "debit"}
                    value={draft.receiptType ?? "debit"}
                    disabled={!editable || busy}
                    aria-invalid={!!errors.receiptType}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        receiptType: event.target.value as ReviewDraft["receiptType"],
                      })
                    }
                  >
                    <option value="">Choose Credit or Debit</option>
                    <option value="debit">Debit — purchase / charge</option>
                    <option value="credit">Credit — return / refund</option>
                  </select>
                  {errors.receiptType && (
                    <p role="alert" className={styles.fieldError}>
                      {errors.receiptType}
                    </p>
                  )}
                  <p>
                    {draft.receiptType === ""
                      ? "Choose Credit or Debit before approving this receipt."
                      : draft.receiptType === "credit"
                        ? "Credit is the default for materials. Enter costs as positive amounts; Credit lines reduce Housecall job costs. You can override each material below."
                        : "Debit is the default for materials. Debit lines add to Housecall job costs; individual materials can be changed to Credit below."}
                  </p>
                </div>
                <p>
                  Job cost = quantity × unit cost. Tax is excluded. Receipt total is reference only.
                </p>
                {errors.lines && (
                  <p role="alert" className={styles.fieldError}>
                    {errors.lines}
                  </p>
                )}
                {editable && (
                  <div className={styles.jobSearch}>
                    <label htmlFor="job-search">Find a Housecall job</label>
                    <input
                      id="job-search"
                      value={jobSearch}
                      maxLength={120}
                      placeholder="Job number, customer, or ID"
                      aria-describedby="job-search-help"
                      aria-controls={
                        showJobResults && jobSearch.trim() ? "job-search-results" : undefined
                      }
                      onFocus={() => setShowJobResults(true)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setShowJobResults(false);
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      onChange={(e) => {
                        setJobSearch(e.target.value);
                        setShowJobResults(true);
                      }}
                    />
                    <p id="job-search-help" className={styles.meta}>
                      Type a name, job number, or address. Choose a match to assign it to all
                      materials.
                    </p>
                    {showJobResults && jobSearch.trim() && (
                      <section
                        id="job-search-results"
                        aria-label="Housecall job search results"
                        className={styles.jobResults}
                        aria-busy={jobResultsLoading}
                      >
                        {jobResultsLoading ? (
                          <p role="status">Searching Housecall jobs…</p>
                        ) : jobError ? (
                          <p role="alert">{jobError}</p>
                        ) : !jobs.length ? (
                          <p role="status">No matching Housecall jobs.</p>
                        ) : (
                          <>
                            <p role="status" className={styles.meta}>
                              {jobs.length === 50
                                ? "First 50 matching jobs. Keep typing to narrow the results."
                                : `${jobs.length} matching ${jobs.length === 1 ? "job" : "jobs"}.`}
                            </p>
                            <ul>
                              {jobs.map((job) => (
                                <li key={job.id}>
                                  <button
                                    type="button"
                                    disabled={busy || job.unavailable || !draft.lines.length}
                                    onClick={() => applyJob(job)}
                                  >
                                    {jobLabel(job)}
                                  </button>
                                  {job.unavailable ? (
                                    <small>Unavailable</small>
                                  ) : job.stale ? (
                                    <small>Details need refreshing before approval</small>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </section>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={olderJobs}
                        onChange={(e) => setOlderJobs(e.target.checked)}
                      />{" "}
                      Include all older jobs
                    </label>
                    <button
                      type="button"
                      disabled={refreshingJobs || busy}
                      onClick={() => void refreshJobs()}
                    >
                      {refreshingJobs ? "Refreshing jobs…" : "Refresh Housecall jobs"}
                    </button>
                    {jobError && !(showJobResults && jobSearch.trim()) && (
                      <p role="alert">{jobError}</p>
                    )}
                    {jobRefreshError && <p role="alert">{jobRefreshError}</p>}
                    {refreshingJobs ? (
                      <p role="status">Checking the latest Housecall jobs. You can keep editing.</p>
                    ) : allJobs.some((job) => job.stale && !job.unavailable) ? (
                      <p className={styles.meta}>
                        You can select and save jobs now. Refresh Housecall jobs before approving to
                        verify their latest details.
                      </p>
                    ) : null}
                    <label htmlFor="bulk-housecall-job">Job for all materials</label>
                    <select
                      id="bulk-housecall-job"
                      value={bulkJobId}
                      disabled={busy}
                      onChange={(event) => {
                        const selected = allJobs.find((job) => job.id === event.target.value);
                        if (selected) applyJob(selected);
                        else setBulkJobId("");
                      }}
                    >
                      <option value="">Choose a job</option>
                      {allJobs.map((job) => (
                        <option key={job.id} value={job.id} disabled={job.unavailable}>
                          {jobLabel(job)}
                          {job.unavailable
                            ? " · Unavailable"
                            : job.stale
                              ? " · Refresh needed"
                              : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !draft.lines.length ||
                        !allJobs.some((job) => job.id === bulkJobId && !job.unavailable)
                      }
                      onClick={() => {
                        const selected = allJobs.find((job) => job.id === bulkJobId);
                        if (selected) applyJob(selected);
                      }}
                    >
                      Apply selected job to all
                    </button>
                    {detail.suggestions.length > 0 && (
                      <div>
                        <strong>Suggested jobs</strong>
                        {detail.suggestions
                          .filter((job) => job.sourceIndex === undefined)
                          .slice(0, 5)
                          .map((job) => (
                            <div key={job.suggestionId}>
                              <span>
                                {jobLabel(allJobs.find((current) => current.id === job.id) ?? job)}
                                {job.score !== undefined && ` · Evidence score ${job.score}`}
                                {allJobs.find((current) => current.id === job.id)?.unavailable
                                  ? " · Unavailable"
                                  : allJobs.find((current) => current.id === job.id)?.stale
                                    ? " · Refresh needed"
                                    : ""}
                              </span>{" "}
                              {job.reasons?.map((reason) => (
                                <details key={reason.code}>
                                  <summary>{reason.message}</summary>
                                  {reason.evidence?.map((evidence) => (
                                    <p key={`${reason.code}-${evidence}`}>{evidence}</p>
                                  ))}
                                </details>
                              ))}
                              <button
                                type="button"
                                disabled={
                                  busy ||
                                  !draft.lines.length ||
                                  allJobs.find((current) => current.id === job.id)?.unavailable
                                }
                                onClick={() => applyJob(job)}
                              >
                                Apply to all
                              </button>
                            </div>
                          ))}
                      </div>
                    )}
                    {!jobs.length && !detail.suggestions.length && !jobError && (
                      <p>
                        No jobs available. Try searching older jobs, or contact your administrator
                        about job sync.
                      </p>
                    )}
                  </div>
                )}
                <div className={styles.lines}>
                  {draft.lines.map((line, index) => (
                    <fieldset
                      key={line.id ?? `legacy-${index}`}
                      className={styles.line}
                      disabled={!editable || busy}
                    >
                      <legend>Material {index + 1}</legend>
                      {detail.suggestions
                        .filter(
                          (job) =>
                            job.sourceIndex !== undefined && job.sourceIndex === line.sourceIndex,
                        )
                        .map((job) => (
                          <div key={job.suggestionId}>
                            <strong>
                              Suggested for this line:{" "}
                              {jobLabel(allJobs.find((current) => current.id === job.id) ?? job)}
                            </strong>
                            {allJobs.find((current) => current.id === job.id)?.unavailable ? (
                              <p>This job is unavailable.</p>
                            ) : allJobs.find((current) => current.id === job.id)?.stale ? (
                              <p>Refresh job details before approving this destination.</p>
                            ) : null}
                            <ul>
                              {job.reasons?.map((reason) => (
                                <li key={reason.code}>
                                  {reason.message}
                                  {reason.evidence?.length
                                    ? ` Evidence: ${reason.evidence.join("; ")}`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              disabled={
                                !editable ||
                                busy ||
                                allJobs.find((current) => current.id === job.id)?.unavailable
                              }
                              onClick={() =>
                                updateLine(index, { jobId: job.id, suggestionId: job.suggestionId })
                              }
                            >
                              Use for this line
                            </button>
                          </div>
                        ))}
                      <div className={styles.lineFields}>
                        <div className={styles.full}>
                          <label htmlFor={`line-${index}-type`}>Material type</label>
                          <select
                            id={`line-${index}-type`}
                            data-receipt-type={line.receiptType ?? draft.receiptType ?? "debit"}
                            value={line.receiptType ?? "inherit"}
                            aria-invalid={!!errors[`lines.${index}.receiptType`]}
                            onChange={(event) =>
                              updateLine(index, {
                                receiptType:
                                  event.target.value === "inherit"
                                    ? undefined
                                    : (event.target.value as ReviewDraft["receiptType"]),
                              })
                            }
                          >
                            <option value="inherit">
                              Use receipt type ({receiptTypeLabel(draft.receiptType)})
                            </option>
                            <option value="debit">Debit — purchase / charge</option>
                            <option value="credit">Credit — return / refund</option>
                            {line.receiptType === "" && <option value="">Choose a type</option>}
                          </select>
                          {errors[`lines.${index}.receiptType`] && (
                            <small className={styles.fieldError}>
                              {errors[`lines.${index}.receiptType`]}
                            </small>
                          )}
                        </div>
                        {(Object.keys(lineLabels) as Array<keyof typeof lineLabels>).map((key) => (
                          <div key={key}>
                            <label htmlFor={`line-${index}-${key}`}>{lineLabels[key]}</label>
                            <input
                              id={`line-${index}-${key}`}
                              name={`line-${index}-${key}`}
                              value={line[key]}
                              inputMode={
                                key === "qty" || key === "unitCost" ? "decimal" : undefined
                              }
                              maxLength={key === "description" ? 500 : 40}
                              aria-invalid={!!errors[`lines.${index}.${key}`]}
                              aria-describedby={
                                errors[`lines.${index}.${key}`]
                                  ? `error-${index}-${key}`
                                  : undefined
                              }
                              onChange={(e) => updateLine(index, { [key]: e.target.value })}
                            />
                            {errors[`lines.${index}.${key}`] && (
                              <small id={`error-${index}-${key}`} className={styles.fieldError}>
                                {errors[`lines.${index}.${key}`]}
                              </small>
                            )}
                          </div>
                        ))}
                      </div>
                      <label htmlFor={`job-${index}`}>Housecall job</label>
                      <select
                        id={`job-${index}`}
                        value={line.jobId}
                        aria-invalid={!!errors[`lines.${index}.jobId`]}
                        onChange={(e) => {
                          const chosen = allJobs.find((j) => j.id === e.target.value);
                          if (chosen?.unavailable) return;
                          if (chosen)
                            setSelectedJobs((current) => [
                              chosen,
                              ...current.filter((job) => job.id !== chosen.id),
                            ]);
                          updateLine(index, {
                            jobId: e.target.value,
                            suggestionId: chosen?.suggestionId,
                          });
                        }}
                      >
                        <option value="">Choose a job</option>
                        {line.jobId && !allJobs.some((j) => j.id === line.jobId) && (
                          <option value={line.jobId}>Saved job — refresh details</option>
                        )}
                        <optgroup label="Suggested">
                          {allJobs
                            .filter((j) => j.suggestionId)
                            .map((j) => (
                              <option key={j.id} value={j.id} disabled={j.unavailable}>
                                {jobLabel(j)}
                                {j.unavailable
                                  ? " · Unavailable"
                                  : j.stale
                                    ? " · Refresh needed"
                                    : ""}
                              </option>
                            ))}
                        </optgroup>
                        <optgroup label={olderJobs ? "Search results" : "Active and recent jobs"}>
                          {allJobs
                            .filter((j) => !j.suggestionId)
                            .map((j) => (
                              <option key={j.id} value={j.id} disabled={j.unavailable}>
                                {jobLabel(j)}
                                {j.unavailable
                                  ? " · Unavailable"
                                  : j.stale
                                    ? " · Refresh needed"
                                    : ""}
                              </option>
                            ))}
                        </optgroup>
                      </select>
                      {errors[`lines.${index}.jobId`] && (
                        <small className={styles.fieldError}>
                          {errors[`lines.${index}.jobId`]}
                        </small>
                      )}
                      {detail.automaticJobAssignments
                        ?.filter(
                          (assignment) =>
                            assignment.lineIndex === index &&
                            (assignment.jobId ? assignment.jobId === line.jobId : !line.jobId),
                        )
                        .map((assignment) => (
                          <p key={assignment.lineIndex} className={styles.notice}>
                            {assignment.message}
                          </p>
                        ))}
                      {allJobs.find((j) => j.id === line.jobId) && (
                        <p className={styles.meta}>
                          {jobMetadata(allJobs.find((job) => job.id === line.jobId) ?? {})}
                          {allJobs.find((j) => j.id === line.jobId)?.unavailable
                            ? " · This job is unavailable. Choose another destination."
                            : allJobs.find((j) => j.id === line.jobId)?.stale
                              ? " · Job details need refreshing. Refresh Housecall jobs above before approval."
                              : ""}
                        </p>
                      )}
                      <div className={styles.lineFooter}>
                        {decimalUnits(line.qty, 3) === 0 && (
                          <p>
                            Zero quantity: kept in this review and excluded from Housecall materials
                            and costs.
                          </p>
                        )}
                        <output aria-label={`Material ${index + 1} extended cost`}>
                          {lineCostCents(line, draft.receiptType) === null
                            ? "—"
                            : money(lineCostCents(line, draft.receiptType))}
                        </output>
                        {editable && (
                          <button
                            type="button"
                            onClick={() => {
                              setDraft({
                                ...draft,
                                lines: draft.lines.filter((_, i) => i !== index),
                              });
                              setTimeout(
                                () =>
                                  form.current
                                    ?.querySelector<HTMLInputElement>(
                                      `[name="line-${Math.max(0, index - 1)}-description"]`,
                                    )
                                    ?.focus(),
                                0,
                              );
                            }}
                          >
                            Delete material {index + 1}
                          </button>
                        )}
                      </div>
                      <details>
                        <summary>Original line evidence</summary>
                        <p>{sourceLineText(detail, line)}</p>
                      </details>
                    </fieldset>
                  ))}
                </div>
                {editable && (
                  <button
                    type="button"
                    disabled={busy || draft.lines.length >= 100}
                    onClick={() => {
                      pendingLineFocus.current = true;
                      setDraft({
                        ...draft,
                        lines: [...draft.lines, { ...emptyLine(), jobId: bulkJobId }],
                      });
                    }}
                  >
                    + Add material
                  </button>
                )}
                <div className={styles.totals}>
                  <strong>Material total</strong>
                  <strong>{money(summary?.totalCents ?? 0)}</strong>
                </div>
                {draft.referenceTotal &&
                  Math.abs(Number(draft.referenceTotal) * 100) !==
                    Math.abs(summary?.totalCents ?? 0) && (
                    <p className={styles.notice}>
                      Material costs differ from the receipt reference total. Check quantities and
                      unit costs; tax, fees, or non-material purchases may explain the difference.
                      No amount will be allocated automatically.
                    </p>
                  )}
                {(summary?.jobCount ?? 0) > 1 && (
                  <p className={styles.notice}>Split across {summary?.jobCount} jobs.</p>
                )}
              </form>
            </div>
            <HousecallPreview
              key={`${id}:${detail.version}`}
              receiptId={id}
              isAdmin={actorRole === "admin"}
            />
            <section className={styles.section}>
              <h2>Housecall progress</h2>
              {detail.automaticExport && pendingExport && !editable && (
                <div>
                  <p>
                    Approval is saved. Delivery is complete when all steps below show succeeded.
                  </p>
                  <button
                    type="button"
                    disabled={busy || loading || detail.correctionPending}
                    onClick={() => void continueExport()}
                  >
                    Continue approved Housecall export
                  </button>
                </div>
              )}
              <p>
                For the current frozen plan, the export preview above shows each receipt page and
                material line separately.
              </p>
              {!detail.steps.length && (
                <p>No export intent. Only approval queues Housecall work.</p>
              )}
              {detail.status === "partial_success" && (
                <p className={styles.notice}>
                  Some Housecall work succeeded. Only unresolved steps need attention.
                </p>
              )}
              <div className={styles.steps}>
                {detail.steps.map((step) => (
                  <article key={step.exportStepId ?? `${step.step}:${step.jobId}:${step.lineId}`}>
                    <h3>
                      {step.step === "attachment" ? "Receipt attachment" : "Job cost"} ·{" "}
                      {jobLabel(allJobs.find((job) => job.id === step.jobId))}
                      {step.pageIndex !== undefined ? ` · Page ${step.pageIndex + 1}` : ""}
                    </h3>
                    <p>
                      {nice(step.status)}
                      {step.retryQueued ? " · Retry queued" : ""}
                    </p>
                    {step.createdAt && (
                      <p>Last attempt: {new Date(step.createdAt).toLocaleString()}</p>
                    )}
                    {step.externalId && (
                      <p>
                        External ID: <code>{step.externalId}</code>
                      </p>
                    )}
                    {step.error && <p>{exportError(step.error)}</p>}
                    {["retryable_failure", "permanent_failure"].includes(step.status) && (
                      <button
                        type="button"
                        disabled={busy || step.retryQueued || detail.correctionPending}
                        onClick={() => {
                          setRetry(step);
                          setAction("retry");
                        }}
                      >
                        Retry this failed step
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {detail.steps.length > 0 && !detail.editable && (
                <>
                  {actorRole === "admin" ? (
                    <button
                      type="button"
                      disabled={busy || detail.correctionPending || correction}
                      onClick={() => {
                        setCorrection(true);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Start correction
                    </button>
                  ) : (
                    <p>An administrator can propose a correction to posted costs.</p>
                  )}
                  {detail.correctionPending && (
                    <p role="status">
                      A correction is awaiting reconciliation. Posted history is preserved.
                    </p>
                  )}
                </>
              )}
            </section>
            <section className={styles.section}>
              <h2>Audit timeline</h2>
              <ol className={styles.timeline}>
                {events.map((event) => (
                  <li key={event.id}>
                    <strong>{nice(event.action)}</strong>
                    <p>
                      {new Date(event.createdAt).toLocaleString()} · {event.actor}
                      {event.version !== null ? ` · Version ${event.version}` : ""}
                    </p>
                    {event.reason && <p>{event.reason}</p>}
                    {event.externalId && <p>External ID: {event.externalId}</p>}
                    {Object.entries(event.changes).map(([field, change]) => (
                      <details key={field}>
                        <summary>
                          {labels[field as keyof typeof labels] || nice(field)} changed
                        </summary>
                        <div className={styles.diff}>
                          <div>
                            <strong>Before</strong>
                            <pre>{formatChange(change.before, allJobs, field)}</pre>
                          </div>
                          <div>
                            <strong>After</strong>
                            <pre>{formatChange(change.after, allJobs, field)}</pre>
                          </div>
                        </div>
                      </details>
                    ))}
                  </li>
                ))}
              </ol>
              {eventCursor && (
                <button type="button" disabled={eventBusy} onClick={() => void moreEvents()}>
                  Load more events
                </button>
              )}
            </section>
            {editable && (
              <footer className={styles.actions}>
                <span>{dirty ? "Unsaved changes" : `Saved version ${detail.version}`}</span>
                {correction ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDraft(detail.draft);
                        setCorrection(false);
                      }}
                    >
                      Cancel correction
                    </button>
                    <button
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => prepare("correction")}
                    >
                      Review correction impact
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={() => prepare("save_draft")}>
                      Save for later
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => prepare("request_clarification")}
                    >
                      Request clarification
                    </button>
                    <button type="button" disabled={busy} onClick={() => prepare("decline")}>
                      Decline
                    </button>
                    <button type="button" disabled={busy} onClick={() => prepare("mark_duplicate")}>
                      Mark duplicate
                    </button>
                    <button
                      className={styles.primary}
                      type="button"
                      disabled={busy}
                      onClick={() => prepare("approve")}
                    >
                      Approve receipt
                    </button>
                  </>
                )}
              </footer>
            )}
            <dialog
              ref={dialog}
              className={styles.dialog}
              onCancel={(e) => {
                if (busy) e.preventDefault();
                else setAction(null);
              }}
              onClose={() => {
                if (!busy) setAction(null);
              }}
              aria-labelledby="decision-title"
            >
              <h2 id="decision-title">
                {action === "approve"
                  ? "Confirm approval"
                  : action === "correction"
                    ? "Correction impact"
                    : nice(action ?? "")}
              </h2>
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              {(action === "approve" || action === "correction") && (
                <>
                  <p>
                    {summary?.exportLineCount} lines to {summary?.jobCount} jobs ·{" "}
                    {money(summary?.totalCents ?? 0)}
                  </p>
                  {!!summary?.excludedLineCount && (
                    <p>
                      {summary.excludedLineCount} zero-quantity lines stay in the review history and
                      will not be sent to Housecall.
                    </p>
                  )}
                  {action === "approve" && (
                    <p>
                      {detail?.automaticExport
                        ? "Approving sends the reviewed receipt images and material costs automatically to the selected Housecall jobs."
                        : "Approval freezes this receipt's export plan. Live Housecall writes require separate explicit approval before any data is sent."}
                    </p>
                  )}
                  <p>
                    Receipt default: {receiptTypeLabel(draft.receiptType)}. Each material's selected
                    type determines whether its cost adds to or reduces Housecall job costs.
                  </p>
                  <ul>
                    {summary?.jobs.map((job) => (
                      <li key={job.id}>
                        {jobLabel(allJobs.find((j) => j.id === job.id))} · {job.lines} lines ·{" "}
                        {money(job.totalCents)}
                      </li>
                    ))}
                  </ul>
                  {action === "correction" && (
                    <>
                      <p>
                        This records a proposal for an administrator to reconcile against Housecall.
                        Existing attachments and costs are preserved; no replacement or reversal is
                        sent automatically.
                      </p>
                      <div className={styles.diff}>
                        <div>
                          <strong>Posted review</strong>
                          <pre>{formatChange(detail.draft.lines, allJobs)}</pre>
                        </div>
                        <div>
                          <strong>Proposed review</strong>
                          <pre>{formatChange(draft.lines, allJobs)}</pre>
                        </div>
                      </div>
                    </>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={tax}
                      onChange={(e) => setTax(e.target.checked)}
                    />
                    {action === "approve"
                      ? "I confirm the destinations and that tax is excluded."
                      : "I reviewed the old/new impact and understand that external reconciliation is required."}
                  </label>
                </>
              )}
              {action === "retry" && (
                <p>
                  Retry only the failed {retry?.step === "attachment" ? "attachment" : "job cost"}{" "}
                  for {jobLabel(allJobs.find((job) => job.id === retry?.jobId))}. Existing
                  successful work is preserved. Reconciliation must check for a committed external
                  record before a new write.
                </p>
              )}
              {action !== "approve" && (
                <>
                  <label htmlFor="decision-reason">Reason *</label>
                  <textarea
                    id="decision-reason"
                    value={reason}
                    maxLength={2000}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </>
              )}
              {action === "request_clarification" && (
                <p>
                  The reason is stored with the receipt. Contact the worker through your agreed
                  communication channel.
                </p>
              )}
              {action === "mark_duplicate" && (
                <>
                  <label htmlFor="canonical-id">Canonical receipt ID *</label>
                  <input
                    id="canonical-id"
                    value={canonical}
                    onChange={(e) => setCanonical(e.target.value)}
                  />
                </>
              )}
              <div className={styles.dialogActions}>
                <button type="button" disabled={busy} onClick={() => setAction(null)}>
                  Cancel
                </button>
                <button
                  className={styles.primary}
                  type="button"
                  disabled={
                    busy ||
                    ((action === "approve" || action === "correction") && !tax) ||
                    (action !== "approve" && !reason.trim()) ||
                    (action === "mark_duplicate" && !canonical.trim())
                  }
                  onClick={() => action && void submit(action)}
                >
                  {busy
                    ? "Saving…"
                    : action === "approve"
                      ? "Approve receipt"
                      : action === "correction"
                        ? "Record correction request"
                        : action === "retry"
                          ? "Queue failed-step retry"
                          : "Confirm decision"}
                </button>
              </div>
            </dialog>
          </>
        )}
      </main>
    </ManagerShell>
  );
}
function formatChange(value: unknown, jobs: ManagerJob[], field = ""): string {
  function readable(item: unknown, key = ""): unknown {
    if (typeof item === "string" && (/job_?id$/i.test(key) || /^job_[a-z0-9]+$/i.test(item)))
      return jobLabel(jobs.find((job) => job.id === item));
    if (Array.isArray(item)) return item.map((entry) => readable(entry));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([name, entry]) => [
          name === "jobId" || name === "job_id" ? "Housecall job" : name,
          readable(entry, name),
        ]),
      );
    return item;
  }
  const result = readable(value, field);
  return result === null || result === undefined
    ? "Not available"
    : typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2);
}
function exportError(code: string) {
  const known: Record<string, string> = {
    unauthenticated: "Housecall needs to be reconnected by an administrator.",
    rate_limited: "Housecall asked us to slow down. Retry after the limit clears.",
    timeout: "The response was uncertain. Reconciliation is required before retry.",
    invalid_request: "Housecall rejected the data. Review it with an administrator.",
  };
  return known[code] || "This export step needs administrator review.";
}
function ReceiptPages({ id, pageCount }: { id: string; pageCount: number }) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, pageCount);
  return (
    <>
      {count > 1 && (
        <nav aria-label="Receipt pages" className={styles.imageTools}>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous page
          </button>
          <output aria-live="polite">
            Page {page + 1} of {count}
          </output>
          <button type="button" disabled={page >= count - 1} onClick={() => setPage((p) => p + 1)}>
            Next page
          </button>
        </nav>
      )}
      <ReceiptImage key={`${id}/${page}`} id={id} pageIndex={page} />
    </>
  );
}

function ReceiptImage({ id, pageIndex }: { id: string; pageIndex: number }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [ratio, setRatio] = useState(1.5);
  const [viewWidth, setViewWidth] = useState(500);
  const viewport = useRef<HTMLElement>(null);
  const loadSequence = useRef(0);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/receipts/${id}/image${pageIndex ? `?page=${pageIndex}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (sequence !== loadSequence.current) return;
      setUrl(data.url);
    } catch {
      if (sequence !== loadSequence.current) return;
      setUrl("");
      setError("Image access is unavailable or expired. Retry without losing your edits.");
    } finally {
      if (sequence === loadSequence.current) setBusy(false);
    }
  }, [id, pageIndex]);
  useEffect(() => {
    setUrl("");
    void load();
    return () => {
      loadSequence.current++;
    };
  }, [load]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const rotated = rotation % 180 !== 0;
  const imageWidth = (Math.max(1, viewWidth - 36) * zoom) / (rotated ? ratio : 1);
  const imageHeight = imageWidth * ratio;
  return (
    <>
      <div className={styles.imageTools}>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
        >
          −
        </button>
        <output>{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
        >
          +
        </button>
        <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)}>
          Rotate
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            viewport.current?.scrollTo({ top: 0, left: 0 });
          }}
        >
          Fit width
        </button>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh image
        </button>
        {url && (
          <a
            href={`/api/receipts/${id}/image?page=${pageIndex}&open=1`}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open original
          </a>
        )}
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" disabled={busy} onClick={() => void load()}>
            Retry image
          </button>
        </p>
      )}
      {busy && <p role="status">Loading image…</p>}
      <section
        ref={viewport}
        className={styles.imageViewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus enables image panning.
        tabIndex={0}
        aria-label="Receipt image. Use arrow keys to pan."
        onKeyDown={(e) => {
          const d: Record<string, [number, number]> = {
            ArrowLeft: [-60, 0],
            ArrowRight: [60, 0],
            ArrowUp: [0, -60],
            ArrowDown: [0, 60],
          };
          if (d[e.key]) {
            e.preventDefault();
            viewport.current?.scrollBy({ left: d[e.key][0], top: d[e.key][1] });
          }
        }}
        onPointerDown={(e) => {
          const v = viewport.current;
          if (v) {
            drag.current = { x: e.clientX, y: e.clientY, left: v.scrollLeft, top: v.scrollTop };
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && viewport.current) {
            viewport.current.scrollLeft = d.left - (e.clientX - d.x);
            viewport.current.scrollTop = d.top - (e.clientY - d.y);
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {url && (
          <div
            className={styles.imageCanvas}
            style={{
              width: Math.max(viewWidth, (rotated ? imageHeight : imageWidth) + 36),
              minHeight: (rotated ? imageWidth : imageHeight) + 36,
            }}
          >
            {/* biome-ignore lint/performance/noImgElement: private originals must bypass shared caches. */}
            <img
              src={url}
              alt={
                pageIndex
                  ? `Original submitted receipt, page ${pageIndex + 1}`
                  : "Original submitted receipt"
              }
              draggable={false}
              referrerPolicy="no-referrer"
              style={{ transform: `rotate(${rotation}deg)`, width: imageWidth, maxWidth: "none" }}
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth > 0) setRatio(img.naturalHeight / img.naturalWidth);
              }}
              onError={() =>
                setError("Image access expired or could not load. Refresh the image to try again.")
              }
            />
          </div>
        )}
      </section>
    </>
  );
}
