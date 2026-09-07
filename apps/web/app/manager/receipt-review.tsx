"use client";
import {
  lineCostCents,
  type ReviewDraft,
  type ReviewLine,
  reviewSummary,
  validateReview,
} from "@svl/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExportStep,
  ManagerJob,
  ReceiptDetail,
  ReviewEvent,
} from "@/lib/manager/review-contract";
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
  const [tax, setTax] = useState(false);
  const [correction, setCorrection] = useState(false);
  const [jobs, setJobs] = useState<ManagerJob[]>([]);
  const [jobSearch, setJobSearch] = useState("");
  const [olderJobs, setOlderJobs] = useState(false);
  const [jobError, setJobError] = useState("");
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  const [retry, setRetry] = useState<ExportStep | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const actionLock = useRef(false);
  const loadSequence = useRef(0);
  const pendingLineFocus = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = !!draft && !!detail && JSON.stringify(draft) !== JSON.stringify(detail.draft);
  const editable = !!detail && (detail.editable || correction);
  const summary = draft ? reviewSummary(draft) : null;
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
    if (action) {
      dialog.current?.showModal();
      setReason("");
      setCanonical("");
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
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setJobError("");
      try {
        const res = await fetch(
          `/api/manager/jobs?search=${encodeURIComponent(jobSearch)}&scope=${olderJobs ? "all" : "active"}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!controller.signal.aborted) setJobs(data.jobs);
      } catch {
        if (!controller.signal.aborted)
          setJobError("Job search is unavailable. Existing selections are preserved.");
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [jobSearch, olderJobs]);
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
      const body = await res.json();
      if (!res.ok) {
        if (body.fields) setErrors(body.fields);
        throw new Error(
          res.status === 409
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
              ? "Approved. Housecall export is queued."
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
    if (!draft) return;
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
        ...(job.suggestionId ? { suggestionId: job.suggestionId } : {}),
      })),
    });
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
      ...jobs.find((job) => job.id === suggestion.id),
      suggestionId: suggestion.suggestionId,
      source: suggestion.source,
    })),
    ...jobs,
  ].filter((j, i, rows) => rows.findIndex((x) => x.id === j.id) === i);
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
        {error && (
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
                <ReceiptImage id={id} />
                <p>
                  {detail.gps
                    ? `Location available · ${detail.gps.lat.toFixed(4)}, ${detail.gps.lng.toFixed(4)}`
                    : "No location was shared with this receipt."}
                </p>
                {detail.pageCount > 1 && (
                  <p>
                    {detail.pageCount} pages were submitted. This inspection view shows the first
                    page.
                  </p>
                )}
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
                <div className={styles.fields}>
                  {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => (
                    <div key={key} className={key === "managerNotes" ? styles.full : undefined}>
                      <label htmlFor={key}>
                        {labels[key]}
                        {["vendor", "purchaseDate", "category"].includes(key) && " *"}
                      </label>
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
                      onChange={(e) => setJobSearch(e.target.value)}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={olderJobs}
                        onChange={(e) => setOlderJobs(e.target.checked)}
                      />{" "}
                      Include older and unscheduled jobs
                    </label>
                    {jobError && <p role="alert">{jobError}</p>}
                    {detail.suggestions.length > 0 && (
                      <div>
                        <strong>Suggested jobs</strong>
                        {detail.suggestions.slice(0, 5).map((job) => (
                          <div key={job.suggestionId}>
                            <span>
                              {job.label} · {job.id} · {job.source || "Stored suggestion"}
                            </span>{" "}
                            <button
                              type="button"
                              disabled={busy || !draft.lines.length}
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
                      <div className={styles.lineFields}>
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
                          updateLine(index, {
                            jobId: e.target.value,
                            suggestionId: chosen?.suggestionId ?? line.suggestionId,
                          });
                        }}
                      >
                        <option value="">Choose a job</option>
                        {line.jobId && !allJobs.some((j) => j.id === line.jobId) && (
                          <option value={line.jobId}>{line.jobId} (saved assignment)</option>
                        )}
                        <optgroup label="Suggested">
                          {allJobs
                            .filter((j) => j.suggestionId)
                            .map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.label} · {j.number || j.id} ·{" "}
                                {j.customer || "Customer unavailable"}
                              </option>
                            ))}
                        </optgroup>
                        <optgroup label={olderJobs ? "Search results" : "Active jobs"}>
                          {allJobs
                            .filter((j) => !j.suggestionId)
                            .map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.label} · {j.number || j.id} ·{" "}
                                {j.customer || "Customer unavailable"}
                              </option>
                            ))}
                        </optgroup>
                      </select>
                      {errors[`lines.${index}.jobId`] && (
                        <small className={styles.fieldError}>
                          {errors[`lines.${index}.jobId`]}
                        </small>
                      )}
                      {allJobs.find((j) => j.id === line.jobId) && (
                        <p className={styles.meta}>
                          {allJobs.find((j) => j.id === line.jobId)?.status || "Status unavailable"}{" "}
                          · {allJobs.find((j) => j.id === line.jobId)?.scheduledAt || "Unscheduled"}{" "}
                          ·{" "}
                          {allJobs.find((j) => j.id === line.jobId)?.technicians.join(", ") ||
                            "Technicians unavailable"}{" "}
                          · ID {line.jobId}
                        </p>
                      )}
                      <div className={styles.lineFooter}>
                        <output aria-label={`Material ${index + 1} extended cost`}>
                          {lineCostCents(line) === null ? "—" : money(lineCostCents(line))}
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
                        <p>
                          {detail.original.lines[line.sourceIndex ?? -1]
                            ? `${detail.original.lines[line.sourceIndex ?? -1].description} · ${detail.original.lines[line.sourceIndex ?? -1].qty} × ${detail.original.lines[line.sourceIndex ?? -1].unitCost}`
                            : "Manually added line"}
                        </p>
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
                      setDraft({ ...draft, lines: [...draft.lines, emptyLine()] });
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
                  Number(draft.referenceTotal) * 100 !== summary?.totalCents && (
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
            <section className={styles.section}>
              <h2>Housecall progress</h2>
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
                  <article key={`${step.step}:${step.jobId}:${step.lineId}`}>
                    <h3>
                      {step.step === "attachment" ? "Receipt attachment" : "Job cost"} ·{" "}
                      {step.jobId}
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
                            <pre>{formatChange(change.before)}</pre>
                          </div>
                          <div>
                            <strong>After</strong>
                            <pre>{formatChange(change.after)}</pre>
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
                      Approve &amp; send to Housecall
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
              {(action === "approve" || action === "correction") && (
                <>
                  <p>
                    {summary?.lineCount} lines to {summary?.jobCount} jobs ·{" "}
                    {money(summary?.totalCents ?? 0)}
                  </p>
                  <ul>
                    {summary?.jobs.map((job) => (
                      <li key={job.id}>
                        {allJobs.find((j) => j.id === job.id)?.label || job.id || "Unassigned"} ·{" "}
                        {job.id} · {job.lines} lines · {money(job.totalCents)}
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
                          <pre>{formatChange(detail.draft.lines)}</pre>
                        </div>
                        <div>
                          <strong>Proposed review</strong>
                          <pre>{formatChange(draft.lines)}</pre>
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
                  for {retry?.jobId}. Existing successful work is preserved. Reconciliation must
                  check for a committed external record before a new write.
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
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
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
                      ? "Approve & send to Housecall"
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
function formatChange(value: unknown) {
  return value === null || value === undefined
    ? "Not available"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
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
function ReceiptImage({ id }: { id: string }) {
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
      const res = await fetch(`/api/receipts/${id}/image`, { cache: "no-store" });
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
  }, [id]);
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
          <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
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
              alt="Original submitted receipt"
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
