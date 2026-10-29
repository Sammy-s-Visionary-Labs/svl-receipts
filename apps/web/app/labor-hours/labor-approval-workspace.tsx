"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  LaborApprovalHistoryItem,
  LaborApprovalWorkspaceData,
} from "@/lib/labor/approval-contract";
import type { JobActivity } from "@/lib/labor/contract";
import {
  laborApprovalActions,
  laborApprovalCanReview,
  laborApprovalPreviewMatches,
  laborApprovalReviewKey,
  laborApprovalSendMatches,
  laborApprovalStatus,
  validLaborApprovalDates,
} from "./approval-view";
import styles from "./labor.module.css";
import approvalStyles from "./labor-approval.module.css";
import { hours, localTime, readApi, shortDate, sourceMoney } from "./labor-view";
import { LaborManualResolution } from "./manual-resolution";

type Props = {
  job: Pick<JobActivity, "housecallJobId" | "name" | "address">;
  initialFrom: string;
  initialTo: string;
  refreshToken: number;
};
const approvalKey = (approval: LaborApprovalHistoryItem) =>
  JSON.stringify([approval.id, approval.snapshotHash]);

export function LaborApprovalWorkspace({ job, initialFrom, initialTo, refreshToken }: Props) {
  const titleId = useId();
  const lunchId = useId();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [selectedWorkers, setSelectedWorkers] = useState<string[] | null>(null);
  const [data, setData] = useState<LaborApprovalWorkspaceData | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewedKey, setReviewedKey] = useState("");
  const [sendKey, setSendKey] = useState("");
  const [sendChecked, setSendChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const sequence = useRef(0);
  const responseVersion = useRef("");
  const requestBusy = useRef(false);
  const backgroundBusy = useRef(false);
  const scope = {
    housecallJobId: job.housecallJobId ?? "",
    fromDate: from,
    toDate: to,
    ...(selectedWorkers === null ? {} : { workerNames: selectedWorkers }),
  };

  useEffect(() => {
    setFrom(initialFrom);
    setTo(initialTo);
    setSelectedWorkers(null);
  }, [initialFrom, initialTo]);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setReviewedKey("");
    setSendKey("");
    setSendChecked(false);
    setLoaded(false);
    responseVersion.current = "";
    if (!job.housecallJobId || !validLaborApprovalDates(from, to)) {
      setData(null);
      setBusy("");
      requestBusy.current = false;
      return false;
    }
    requestBusy.current = true;
    setBusy("loading");
    setError("");
    try {
      const query = new URLSearchParams({
        housecallJobId: job.housecallJobId,
        fromDate: from,
        toDate: to,
      });
      if (selectedWorkers !== null) query.set("workers", JSON.stringify(selectedWorkers));
      const result = await readApi<LaborApprovalWorkspaceData>(
        await fetch(`/api/manager/labor/approvals?${query}`, { cache: "no-store" }),
      );
      if (current !== sequence.current) return false;
      if (
        !laborApprovalPreviewMatches(result.preview, {
          housecallJobId: job.housecallJobId,
          fromDate: from,
          toDate: to,
          ...(selectedWorkers === null ? {} : { workerNames: selectedWorkers }),
        })
      )
        throw new Error("The review no longer matches these dates. Refresh the job review.");
      setData(result);
      responseVersion.current = JSON.stringify(result);
      setLoaded(true);
      return true;
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not load the job-hour review.");
      return false;
    } finally {
      if (current === sequence.current) {
        setBusy("");
        requestBusy.current = false;
      }
    }
  }, [job.housecallJobId, from, to, selectedWorkers]);

  useEffect(() => {
    // A refreshed dashboard or a changed range requires a fresh server review and checkbox.
    void refreshToken;
    setNotice("");
    void load();
    return () => {
      sequence.current++;
    };
  }, [load, refreshToken]);

  useEffect(() => {
    if (!job.housecallJobId || !validLaborApprovalDates(from, to)) return;
    const housecallJobId = job.housecallJobId;
    async function checkCurrentReview() {
      if (document.visibilityState === "hidden" || requestBusy.current || backgroundBusy.current)
        return;
      const current = sequence.current;
      backgroundBusy.current = true;
      try {
        const query = new URLSearchParams({ housecallJobId, fromDate: from, toDate: to });
        if (selectedWorkers !== null) query.set("workers", JSON.stringify(selectedWorkers));
        const result = await readApi<LaborApprovalWorkspaceData>(
          await fetch(`/api/manager/labor/approvals?${query}`, { cache: "no-store" }),
        );
        if (current !== sequence.current || requestBusy.current) return;
        if (
          !laborApprovalPreviewMatches(result.preview, {
            housecallJobId,
            fromDate: from,
            toDate: to,
            ...(selectedWorkers === null ? {} : { workerNames: selectedWorkers }),
          })
        )
          throw new Error(
            "The review changed. Refresh the job review before approving or sending.",
          );
        const version = JSON.stringify(result);
        if (version !== responseVersion.current) {
          responseVersion.current = version;
          setData(result);
          setReviewedKey("");
          setSendKey("");
          setSendChecked(false);
          setNotice("Job review updated. Check the current hours and approval status again.");
        }
        setLoaded(true);
        setError("");
      } catch (cause) {
        if (current === sequence.current && !requestBusy.current) {
          setLoaded(false);
          setReviewedKey("");
          setSendKey("");
          setSendChecked(false);
          setError(
            cause instanceof Error ? cause.message : "Could not verify the current job review.",
          );
        }
      } finally {
        backgroundBusy.current = false;
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkCurrentReview();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [job.housecallJobId, from, to, selectedWorkers]);

  const preview = data?.preview;
  const current = !!preview && loaded && laborApprovalPreviewMatches(preview, scope);
  const reviewKey = preview ? laborApprovalReviewKey(preview) : "";
  const alreadyApproved = data?.approvals.some(
    (item) =>
      item.snapshotHash === preview?.snapshotHash &&
      item.fromDate === from &&
      item.toDate === to &&
      !["revoked", "stale"].includes(item.status),
  );
  const canApprove = current && !busy && !alreadyApproved && laborApprovalCanReview(preview, scope);

  function changeDate(which: "from" | "to", value: string) {
    setReviewedKey("");
    setSendKey("");
    setSendChecked(false);
    setLoaded(false);
    setNotice("");
    setSelectedWorkers(null);
    if (which === "from") setFrom(value);
    else setTo(value);
  }

  function chooseWorkers(workerNames: string[] | null) {
    setReviewedKey("");
    setSendKey("");
    setSendChecked(false);
    setLoaded(false);
    setNotice("");
    setSelectedWorkers(workerNames === null ? null : [...workerNames].sort());
  }

  function reviewApproval(approval: LaborApprovalHistoryItem) {
    setReviewedKey("");
    setSendKey("");
    setSendChecked(false);
    setLoaded(false);
    setNotice("");
    setFrom(approval.fromDate);
    setTo(approval.toDate);
    setSelectedWorkers([...approval.approvedWorkerNames].sort());
  }

  async function mutate(body: Record<string, unknown>, success: string) {
    requestBusy.current = true;
    setBusy(String(body.action));
    setError("");
    setNotice("");
    setReviewedKey("");
    setSendChecked(false);
    try {
      await readApi(
        await fetch("/api/manager/labor/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      await load();
      setNotice(success);
    } catch (cause) {
      setLoaded(false);
      setSendKey("");
      setError(
        cause instanceof Error
          ? cause.message
          : "The action could not be confirmed. Refresh first.",
      );
    } finally {
      setBusy("");
      requestBusy.current = false;
    }
  }

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canApprove || !preview || reviewedKey !== reviewKey) return;
    void mutate(
      {
        action: "approve",
        ...scope,
        workerNames: preview.workers.map((worker) => worker.workerName).sort(),
        expectedSnapshotHash: preview.snapshotHash,
        expectedStorageRevision: preview.storageRevision,
        reviewed: true,
      },
      "Hours approved for this job and these dates. Approval does not send hours to Housecall.",
    );
  }

  return (
    <section
      id="job-labor-approval"
      className={styles.card}
      aria-labelledby={titleId}
      aria-busy={Boolean(busy)}
    >
      <div className={styles.cardHeader}>
        <div>
          <h2 id={titleId}>Review and approve job hours</h2>
          <p>Approval and sending are separate actions.</p>
        </div>
        <span className={styles.badge}>Manager approval</span>
      </div>
      <div className={styles.cardBody}>
        {!job.housecallJobId ? (
          <p className={styles.notice}>
            Confirm a specific Housecall job and its work dates before reviewing hours for approval.{" "}
            <Link href="/labor-hours#labor-job-mapping-title">Review Housecall job links</Link>
          </p>
        ) : (
          <>
            <p className={styles.muted}>
              Choose the workers and work dates for this job approval. All workers start selected;
              missing rates are never treated as zero or omitted automatically. The worker-hours
              filter above does not narrow this approval. Source rows remain available below.
            </p>
            <form
              className={approvalStyles.scope}
              onSubmit={(event) => {
                event.preventDefault();
                void load();
              }}
            >
              <label>
                First work date
                <input
                  type="date"
                  required
                  value={from}
                  onChange={(event) => changeDate("from", event.target.value)}
                  disabled={Boolean(busy) && busy !== "loading"}
                />
              </label>
              <label>
                Last work date
                <input
                  type="date"
                  required
                  min={from || undefined}
                  value={to}
                  onChange={(event) => changeDate("to", event.target.value)}
                  disabled={Boolean(busy) && busy !== "loading"}
                />
              </label>
              <button className={styles.button} type="submit" disabled={Boolean(busy)}>
                {busy === "loading" ? "Refreshing review…" : "Refresh job review"}
              </button>
            </form>
            {!validLaborApprovalDates(from, to) && (
              <p className={styles.muted}>Choose a valid first and last work date.</p>
            )}
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
            {preview && data && (
              <>
                <p role="status" className={styles.notice}>
                  {data.capability.message}
                  {!data.capability.sendingEnabled &&
                    " Sending is disabled; approval only saves the reviewed hours inside this app."}
                </p>
                <p className={styles.muted}>
                  The send destination is Housecall Job Inputs &gt; Materials. Review the exact
                  item, quantity and estimated cost below. This does not enter native Housecall
                  timesheets or payroll.
                </p>
                <fieldset className={approvalStyles.workers} disabled={Boolean(busy)}>
                  <legend>Workers included in this approval</legend>
                  <p className={styles.muted}>
                    {preview.workers.length} of {preview.availableWorkers.length} workers selected.
                    Deselected workers remain in the source hours and require their own approval.
                  </p>
                  <div className={approvalStyles.workerChecks}>
                    {preview.availableWorkers.map((worker) => (
                      <label className={approvalStyles.check} key={worker.workerName}>
                        <input
                          type="checkbox"
                          checked={(
                            selectedWorkers ??
                            preview.availableWorkers.map((item) => item.workerName)
                          ).includes(worker.workerName)}
                          onChange={(event) => {
                            const selected =
                              selectedWorkers ??
                              preview.availableWorkers.map((item) => item.workerName);
                            chooseWorkers(
                              event.target.checked
                                ? [...selected, worker.workerName]
                                : selected.filter((name) => name !== worker.workerName),
                            );
                          }}
                        />
                        {worker.workerName} · {hours(worker.hours)} h before lunch
                      </label>
                    ))}
                  </div>
                  <button
                    className={styles.textButton}
                    type="button"
                    onClick={() => {
                      if (selectedWorkers === null) void load();
                      else chooseWorkers(null);
                    }}
                  >
                    Select all workers
                  </button>
                </fieldset>
                <div className={approvalStyles.destination}>
                  <strong>{preview.jobName}</strong>
                  <span>{preview.address || "Housecall address not supplied"}</span>
                  <span>Housecall job ID: {preview.housecallJobId}</span>
                  <span>
                    {shortDate(preview.fromDate)} – {shortDate(preview.toDate)}
                  </span>
                </div>
                <dl className={styles.detailMetrics}>
                  <div>
                    <dt>Job hours before lunch</dt>
                    <dd>{hours(preview.totalHours)}</dd>
                  </div>
                  <div>
                    <dt>Travel included</dt>
                    <dd>{hours(preview.travelHours)}</dd>
                  </div>
                  <div>
                    <dt>Workers</dt>
                    <dd>{preview.workers.length}</dd>
                  </div>
                  <div>
                    <dt>Source intervals</dt>
                    <dd>{preview.entryCount}</dd>
                  </div>
                </dl>
                <p id={lunchId} className={approvalStyles.lunch}>
                  <strong>These job hours are before the worker-day lunch deduction.</strong>{" "}
                  {preview.lunchDisclosure} Source quantities stay unchanged; the estimated paid
                  hours and labor costs below use the reviewed lunch and overtime policy.
                </p>
                <section aria-label="Estimated job labor costs">
                  <h3 className={approvalStyles.historyTitle}>
                    Lunch, overtime and estimated labor cost
                  </h3>
                  <p className={styles.muted}>{preview.costEstimate.policyDescription}</p>
                  <p className={styles.muted}>
                    Clock displays are rounded to minutes. Same-minute source rows of 0.01–0.02 h
                    retain their reported quantity and a review warning. Source row order breaks
                    ties before the following interval; true overlaps still block approval.
                  </p>
                  <dl className={styles.detailMetrics}>
                    <div>
                      <dt>Estimated paid hours</dt>
                      <dd>{hours(preview.costEstimate.paidHours)}</dd>
                    </div>
                    <div>
                      <dt>Regular hours</dt>
                      <dd>
                        {preview.costEstimate.regularHours === null
                          ? "Needs review"
                          : hours(preview.costEstimate.regularHours)}
                      </dd>
                    </div>
                    <div>
                      <dt>Overtime hours</dt>
                      <dd>
                        {preview.costEstimate.overtimeHours === null
                          ? "Needs review"
                          : hours(preview.costEstimate.overtimeHours)}
                      </dd>
                    </div>
                    <div>
                      <dt>Estimated labor cost</dt>
                      <dd>{sourceMoney(preview.costEstimate.totalCostCents)}</dd>
                    </div>
                  </dl>
                  {preview.costEstimate.unpricedHours > 0 && (
                    <p className={styles.warnings}>
                      {hours(preview.costEstimate.unpricedHours)} paid hours do not have a confirmed
                      rate. They are not assigned a zero cost.
                    </p>
                  )}
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <caption className={approvalStyles.caption}>
                        Estimated costs for selected workers
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Worker</th>
                          <th scope="col" className={styles.number}>
                            Hourly rate / overtime
                          </th>
                          <th scope="col" className={styles.number}>
                            Paid hours
                          </th>
                          <th scope="col" className={styles.number}>
                            Regular
                          </th>
                          <th scope="col" className={styles.number}>
                            Overtime
                          </th>
                          <th scope="col" className={styles.number}>
                            Estimated cost
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.costEstimate.workers.map((worker) => (
                          <tr key={worker.workerName}>
                            <td>{worker.workerName}</td>
                            <td className={styles.number}>
                              {sourceMoney(worker.hourlyRateCents)}
                              <small>{worker.overtimeMultiplier}× overtime</small>
                            </td>
                            <td className={styles.number}>{hours(worker.paidHours)}</td>
                            <td className={styles.number}>
                              {worker.regularHours === null
                                ? "Needs review"
                                : hours(worker.regularHours)}
                            </td>
                            <td className={styles.number}>
                              {worker.overtimeHours === null
                                ? "Needs review"
                                : hours(worker.overtimeHours)}
                            </td>
                            <td className={styles.number}>{sourceMoney(worker.costCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                {preview.housecallInput && (
                  <section
                    className={approvalStyles.material}
                    aria-label="Exact Housecall Materials item"
                  >
                    <h3 className={approvalStyles.historyTitle}>
                      Exact Materials item for this approval
                    </h3>
                    <strong>{preview.housecallInput.name}</strong>
                    <p className={approvalStyles.description}>
                      {preview.housecallInput.description}
                    </p>
                    <dl className={styles.detailMetrics}>
                      <div>
                        <dt>Quantity</dt>
                        <dd>
                          {preview.housecallInput.quantity.toLocaleString("en-US", {
                            maximumFractionDigits: 6,
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>Unit cost</dt>
                        <dd>{sourceMoney(preview.housecallInput.unitCostCents)}</dd>
                      </div>
                    </dl>
                    <p className={styles.muted}>
                      This is the exact item content reviewed for sending to this job’s Materials.
                    </p>
                  </section>
                )}
                {preview.blockers.length > 0 && (
                  <div className={styles.error}>
                    <strong>Approval blocked</strong>
                    <ul>
                      {preview.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.warnings.length > 0 && (
                  <div className={styles.warnings}>
                    <strong>Review warnings retained with these hours</strong>
                    <ul>
                      {preview.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.unresolved.entryCount > 0 && (
                  <p className={styles.warnings}>
                    Separate unresolved queue: {preview.unresolved.entryCount} intervals /{" "}
                    {hours(preview.unresolved.hours)} h in this date range are not included in this
                    job’s approval.{" "}
                    <Link href="/labor-hours?allocation=pending">Review unresolved hours</Link>
                  </p>
                )}
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <caption className={approvalStyles.caption}>
                      Selected workers and work days in this review
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Worker / day</th>
                        <th scope="col">Intervals</th>
                        <th scope="col" className={styles.number}>
                          Job hours
                        </th>
                        <th scope="col" className={styles.number}>
                          Travel included
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.workers.flatMap((worker) =>
                        worker.days.map((day) => (
                          <tr key={`${worker.workerName}:${day.date}`}>
                            <td>
                              <strong>{worker.workerName}</strong>
                              <small>{shortDate(day.date)}</small>
                            </td>
                            <td>{day.entryCount}</td>
                            <td className={styles.number}>{hours(day.hours)}</td>
                            <td className={styles.number}>{hours(day.travelHours)}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
                <details className={approvalStyles.entries}>
                  <summary>
                    Review {preview.entries.length} original intervals and allocation reasons
                  </summary>
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Worker / date</th>
                          <th scope="col">Original source / clocks</th>
                          <th scope="col" className={styles.number}>
                            Job hours
                          </th>
                          <th scope="col">Decision / source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.entries.map((entry) => (
                          <tr key={entry.sourceEntryId}>
                            <td>
                              {entry.workerName}
                              <small>{shortDate(entry.date)}</small>
                            </td>
                            <td>
                              {entry.sourceJobName}
                              <small>
                                {entry.clockIn || "—"} – {entry.clockOut || "—"}
                              </small>
                              <small>Original source quantity: {hours(entry.sourceHours)} h</small>
                            </td>
                            <td className={styles.number}>{hours(entry.hours)}</td>
                            <td>
                              {entry.reason.replaceAll("_", " ")}
                              <small>
                                {entry.originalUrl ? (
                                  <a href={entry.originalUrl}>
                                    Original Excel · row {entry.sourceRow}
                                  </a>
                                ) : (
                                  `Source row ${entry.sourceRow}`
                                )}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                <form className={approvalStyles.approve} onSubmit={approve}>
                  <label className={approvalStyles.check}>
                    <input
                      type="checkbox"
                      checked={reviewedKey === reviewKey && !!reviewKey}
                      disabled={!canApprove}
                      onChange={(event) => setReviewedKey(event.target.checked ? reviewKey : "")}
                      aria-describedby={lunchId}
                    />
                    I reviewed the exact Housecall job, selected workers, source intervals, work
                    dates, proportional lunch, weekly overtime, estimated costs and Materials item.
                  </label>
                  <button
                    className={styles.primary}
                    type="submit"
                    disabled={!canApprove || reviewedKey !== reviewKey}
                  >
                    {busy === "approve" ? "Saving approval…" : "Approve hours"}
                  </button>
                  <p className={styles.muted}>
                    {alreadyApproved
                      ? "This version already has an approval. See its status below."
                      : preview.entryCount === 0
                        ? "There are no allocated intervals for this job in these dates."
                        : "Awaiting approval. Changed source hours, rules or job links require review again."}
                  </p>
                </form>
                <h3 className={approvalStyles.historyTitle}>Approval and send history</h3>
                {data.approvals.length === 0 ? (
                  <p className={styles.muted}>No approvals recorded for this job yet.</p>
                ) : (
                  <div className={approvalStyles.history}>
                    {data.approvals.map((item) => {
                      const actions = laborApprovalActions(item, data.capability);
                      const sameReview = current && laborApprovalSendMatches(item, preview, scope);
                      const key = approvalKey(item);
                      return (
                        <article key={item.id} className={approvalStyles.historyItem}>
                          <strong>{laborApprovalStatus[item.status]}</strong>
                          <p>
                            {shortDate(item.fromDate)} – {shortDate(item.toDate)} ·{" "}
                            {hours(item.hours)} h before lunch
                          </p>
                          <p>
                            {hours(item.paidHours)} estimated paid hours ·{" "}
                            {sourceMoney(item.estimatedCostCents)} estimated labor cost
                          </p>
                          <p className={styles.muted}>
                            Approved workers: {item.approvedWorkerNames.join(", ")}
                          </p>
                          <p className={styles.muted}>
                            Approved {localTime(item.approvedAt)}
                            {item.sentAt && ` · sent ${localTime(item.sentAt)}`}
                          </p>
                          {item.lastError && <p className={styles.error}>{item.lastError}</p>}
                          {item.status === "stale" && (
                            <p className={styles.muted}>
                              The reviewed source has changed. Refresh the dates above and approve
                              the new version before sending.
                            </p>
                          )}
                          {item.status === "failed" && (
                            <p className={styles.muted}>
                              The attempt stopped before any Housecall write was dispatched. A retry
                              requires a fresh review and a new send confirmation.
                            </p>
                          )}
                          {["sending", "reconciliation_required"].includes(item.status) && (
                            <p className={styles.muted}>
                              Check the existing attempt before any further send. Verification does
                              not create another copy.
                            </p>
                          )}
                          <div className={styles.actions}>
                            {!sameReview &&
                              ["approved", "failed", "stale"].includes(item.status) && (
                                <button
                                  className={styles.button}
                                  type="button"
                                  disabled={!!busy}
                                  onClick={() => reviewApproval(item)}
                                >
                                  Review this approval
                                </button>
                              )}
                            {["approved", "failed"].includes(item.status) && (
                              <button
                                className={styles.button}
                                type="button"
                                disabled={!actions.send || !sameReview || !!busy}
                                onClick={async () => {
                                  setSendKey("");
                                  setSendChecked(false);
                                  if (item.status === "failed" && !(await load())) return;
                                  setSendKey(key);
                                }}
                              >
                                {item.status === "failed" ? "Retry send…" : "Send approved hours…"}
                              </button>
                            )}
                            {actions.verify && (
                              <button
                                className={styles.button}
                                type="button"
                                disabled={!current || !!busy}
                                onClick={() =>
                                  void mutate(
                                    { action: "verify", approvalId: item.id },
                                    "The existing send attempt was checked. Review its current status below.",
                                  )
                                }
                              >
                                Verify existing send
                              </button>
                            )}
                            {actions.revoke && (
                              <button
                                className={styles.textButton}
                                type="button"
                                disabled={!current || !!busy}
                                onClick={() =>
                                  void mutate(
                                    { action: "revoke", approvalId: item.id },
                                    "Approval revoked. These hours require a new review before sending.",
                                  )
                                }
                              >
                                Revoke approval
                              </button>
                            )}
                          </div>
                          {sendKey === key && actions.send && sameReview && (
                            <form
                              className={approvalStyles.send}
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (!sendChecked || !sameReview || busy) return;
                                void mutate(
                                  {
                                    action: "send",
                                    approvalId: item.id,
                                    expectedSnapshotHash: item.snapshotHash,
                                    confirmed: true,
                                  },
                                  "Send request checked. See the recorded status; do not repeat an uncertain send.",
                                );
                              }}
                            >
                              <p>
                                <strong>
                                  Send {hours(item.hours)} approved hours to {item.jobName}
                                </strong>
                                <br />
                                {shortDate(item.fromDate)} – {shortDate(item.toDate)}
                              </p>
                              <p className={styles.muted}>
                                Housecall Job Inputs &gt; Materials ·{" "}
                                {sourceMoney(item.estimatedCostCents)} estimated labor cost.
                                {data.capability.message}
                              </p>
                              <label className={approvalStyles.check}>
                                <input
                                  type="checkbox"
                                  checked={sendChecked}
                                  onChange={(event) => setSendChecked(event.target.checked)}
                                  disabled={!!busy}
                                />
                                I confirm this separate send of the approved hours and estimated
                                labor cost to this job’s Materials.
                              </label>
                              <div className={styles.actions}>
                                <button
                                  className={styles.primary}
                                  type="submit"
                                  disabled={!sendChecked || !sameReview || !!busy}
                                >
                                  Confirm send approved hours
                                </button>
                                <button
                                  className={styles.button}
                                  type="button"
                                  disabled={!!busy}
                                  onClick={() => {
                                    setSendKey("");
                                    setSendChecked(false);
                                  }}
                                >
                                  Cancel send
                                </button>
                              </div>
                            </form>
                          )}
                          {["sent", "reconciliation_required"].includes(item.status) && (
                            <LaborManualResolution key={key} approval={item} />
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
