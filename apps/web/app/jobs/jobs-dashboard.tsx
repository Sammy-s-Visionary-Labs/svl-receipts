"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobActivity, JobReceiptActivity, JobsDashboardData } from "@/lib/labor/contract";
import { allocatedWorkerDays, allocationReason } from "../labor-hours/allocation-view";
import styles from "../labor-hours/labor.module.css";
import { LaborApprovalWorkspace } from "../labor-hours/labor-approval-workspace";
import { hours, localTime, readApi, shortDate, sourceMoney } from "../labor-hours/labor-view";
import { Icon } from "../manager/icons";
import { filterJobActivity, resolveJobSelection } from "./job-view";

export function JobsDashboard() {
  const [data, setData] = useState<JobsDashboardData | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [worker, setWorker] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await readApi<JobsDashboardData>(
        await fetch("/api/manager/jobs/activity", { cache: "no-store" }),
      );
      if (current !== sequence.current) return;
      setData(result);
      setApprovalRefresh((value) => value + 1);
      setError("");
      setSelectedKey((value) => value || result.jobs[0]?.key || "");
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not load job activity.");
    }
  }, []);

  useEffect(() => {
    setSelectedKey(new URLSearchParams(window.location.search).get("job") ?? "");
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);

  const activity = filterJobActivity(
    data?.jobs ?? [],
    data?.allocation.entries ?? [],
    data?.unassignedReceipts ?? [],
    { from, to, worker },
    data?.workerAliases,
  );
  const query = search.trim().toLocaleLowerCase();
  const visibleJobs = activity.jobs.filter(
    (job) =>
      !query ||
      [job.name, job.address, job.housecallJobId ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
  );
  const selection = resolveJobSelection(
    data?.jobs ?? [],
    data?.allocation.entries ?? [],
    selectedKey,
  );
  const selected = selection.job;
  const sourceEntries = new Map(data?.entries.map((entry) => [entry.id, entry]) ?? []);
  const imports = new Map(data?.imports.map((item) => [item.id, item]) ?? []);
  const selectedAllocations = (data?.allocation.entries ?? []).filter(
    (entry) => entry.status === "allocated" && entry.job?.key === selected?.key,
  );
  const entries = activity.allocations.filter(
    (entry) => entry.status === "allocated" && entry.job?.key === selected?.key,
  );
  const dailyGroups = allocatedWorkerDays(entries, data?.workerAliases);
  const pending = activity.allocations.filter((entry) => entry.status === "pending");
  const receipts = activity.jobs.find((job) => job.key === selected?.key)?.receipts ?? [];
  const unassignedReceipts = activity.unassignedReceipts;
  const pendingHours = pending.reduce((sum, entry) => sum + entry.pendingHours, 0);
  const filteredHours = entries.reduce((sum, entry) => sum + entry.allocatedHours, 0);
  const approvalDates = selectedAllocations.map((entry) => entry.date).sort();
  const sourceDates = (data?.entries ?? []).map((entry) => entry.date).sort();
  const filteredTravel = entries.reduce(
    (sum, entry) => sum + (entry.sourceKind === "travel" ? entry.allocatedHours : 0),
    0,
  );
  const receiptTotal =
    receipts.length > 0 && receipts.every((receipt) => receipt.amountCents !== null)
      ? receipts.reduce((sum, receipt) => sum + (receipt.amountCents ?? 0), 0)
      : null;

  function choose(job: JobActivity) {
    setSelectedKey(job.key);
    setWorker("");
    const url = new URL(window.location.href);
    url.searchParams.set("job", job.key);
    window.history.replaceState(null, "", url);
  }

  return (
    <main id="main-content" className={styles.main}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>JOB ACTIVITY</p>
          <h1 className={styles.title}>Jobs</h1>
          <p className={styles.subtitle}>
            See assigned receipts and customer-job hours calculated from the reviewed labor rules.
            Unresolved hours remain in the review queue, and original source rows stay available.
          </p>
        </div>
        <div className={styles.actions}>
          {data?.development && <span className={styles.badge}>Development</span>}
          <button className={styles.button} type="button" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {!data ? (
        <div className={styles.card}>
          <div className={styles.empty}>
            {error
              ? "Job activity is unavailable. Use Refresh to try again."
              : "Loading job activity…"}
          </div>
        </div>
      ) : (
        <>
          {data.warnings.length > 0 && (
            <div className={styles.warnings}>
              <ul>
                {data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span>Jobs with activity</span>
              <strong>{activity.summary.jobCount}</strong>
              <small>Receipts or imported hours</small>
            </div>
            <div className={styles.metric}>
              <span>Allocated job hours</span>
              <strong>{hours(activity.summary.allocatedHours)}</strong>
              <small>Before daily lunch</small>
            </div>
            <div className={styles.metric}>
              <span>Assigned receipts</span>
              <strong>{activity.summary.assignedReceiptCount}</strong>
              <small>Across job groupings</small>
            </div>
            <div className={styles.metric}>
              <span>Unassigned receipts</span>
              <strong>{activity.summary.unassignedReceiptCount}</strong>
              <small>Awaiting a job assignment</small>
            </div>
          </div>
          <div className={styles.filters}>
            <label>
              Find a job
              <input
                type="search"
                placeholder="Job name, address or Housecall ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              Worker hours
              <select value={worker} onChange={(event) => setWorker(event.target.value)}>
                <option value="">All workers</option>
                {[...new Set(data.allocation.workerDays.map((day) => day.workerName))]
                  .sort()
                  .map((name) => (
                    <option key={name}>{name}</option>
                  ))}
              </select>
            </label>
            <label>
              From
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              Through
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
          <p className={styles.notice}>
            Materials under Housecall Job Inputs is the intended destination. This preview does not
            send hours. Sending requires job-hour approval and a separate confirmation. Worker-day
            lunch is separate from job hours.
          </p>
          {pendingHours > 0 && (
            <p className={styles.warnings}>
              {hours(pendingHours)} hours await allocation review.{" "}
              <Link className={styles.textButton} href="/labor-hours?allocation=pending">
                Review unresolved hours
              </Link>
            </p>
          )}
          <div className={styles.filterActions}>
            <span>
              Summary cards and job groups use the selected work dates and receipt submission dates.
              Worker filters apply to hours.
            </span>
            <button
              className={styles.textButton}
              type="button"
              onClick={() => {
                setSearch("");
                setWorker("");
                setFrom("");
                setTo("");
              }}
            >
              Clear filters
            </button>
          </div>
          {selection.ambiguous && (
            <p role="status" className={styles.notice}>
              This source location is linked to different Housecall jobs for different work dates.
              Select the specific Housecall job below.
            </p>
          )}
          <section className={styles.jobList} aria-label="Jobs and their activity">
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2>Job groups</h2>
                <p>{visibleJobs.length}</p>
              </div>
              {visibleJobs.length === 0 ? (
                <div className={styles.empty}>No jobs with activity in these filters.</div>
              ) : (
                visibleJobs.map((job) => (
                  <button
                    className={styles.jobButton}
                    type="button"
                    key={job.key}
                    aria-pressed={selected?.key === job.key}
                    onClick={() => choose(job)}
                  >
                    <strong>{job.name}</strong>
                    <small>{job.address || "Address not supplied"}</small>
                    <small>
                      {hours(job.hours)} h · {job.workerCount} workers · {job.receiptCount} receipts
                    </small>
                    <small>
                      {job.allocationStatus === "mapped"
                        ? "Matched Housecall job"
                        : job.allocationStatus === "unassigned"
                          ? "Unassigned"
                          : job.allocationStatus === "allocated"
                            ? "Allocated customer job"
                            : "Source grouping"}
                    </small>
                  </button>
                ))
              )}
            </div>
            <div className={styles.card}>
              {!selected ? (
                <div className={styles.empty}>
                  <strong>Select a job</strong>Choose a job group to see its receipts and hours.
                </div>
              ) : (
                <>
                  <div className={styles.detailHeader}>
                    <h2 className={styles.detailTitle}>{selected.name}</h2>
                    <p className={styles.detailAddress}>
                      {selected.address || "Address not supplied"}
                    </p>
                    <span className={styles.badge}>
                      {selected.allocationStatus === "mapped"
                        ? "Matched Housecall job"
                        : selected.allocationStatus === "allocated"
                          ? "Allocated customer job"
                          : selected.allocationStatus === "source_only"
                            ? "Source receipt grouping"
                            : "Unassigned"}
                    </span>
                    {selected.housecallJobId && (
                      <p className={styles.detailAddress}>
                        Housecall job ID: {selected.housecallJobId}
                      </p>
                    )}
                    <a className={styles.textButton} href="#job-labor-approval">
                      Review and approve hours
                    </a>
                    <dl className={styles.detailMetrics}>
                      <div>
                        <dt>Allocated hours</dt>
                        <dd>{hours(filteredHours)}</dd>
                      </div>
                      <div>
                        <dt>Source travel included</dt>
                        <dd>{hours(filteredTravel)}</dd>
                      </div>
                      <div>
                        <dt>Receipts</dt>
                        <dd>{receipts.length}</dd>
                      </div>
                      <div>
                        <dt>Receipt amount</dt>
                        <dd>{sourceMoney(receiptTotal)}</dd>
                      </div>
                    </dl>
                  </div>
                  <h3 className={styles.sectionLabel}>Receipts</h3>
                  {receipts.length === 0 ? (
                    <div className={styles.empty}>
                      No receipts assigned to this job in the selected dates.
                    </div>
                  ) : (
                    <ReceiptTable receipts={receipts} />
                  )}
                  <div className={styles.cardHeader}>
                    <h3 className={styles.sectionLabel}>Hours by worker and day</h3>
                    <Link className={styles.textButton} href="/labor-hours">
                      Labor allocation review
                    </Link>
                  </div>
                  {dailyGroups.length === 0 ? (
                    <div className={styles.empty}>
                      No imported hours for this job in the selected filters.
                    </div>
                  ) : (
                    <div className={styles.tableScroll}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Work date</th>
                            <th>Worker</th>
                            <th>Entries</th>
                            <th className={styles.number}>Hours</th>
                            <th className={styles.number}>Source travel included</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyGroups.map((group) => (
                            <tr key={group.key}>
                              <td className={styles.nowrap}>{shortDate(group.date)}</td>
                              <td>{group.workerName}</td>
                              <td>{group.entryCount}</td>
                              <td className={styles.number}>{hours(group.hours)}</td>
                              <td className={styles.number}>{hours(group.sourceTravelHours)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <details className={styles.cardBody}>
                    <summary>
                      Original source and allocation decisions · {entries.length} entries
                    </summary>
                    <div className={styles.tableScroll}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Worker / date</th>
                            <th>Recorded source</th>
                            <th className={styles.number}>Allocated hours</th>
                            <th>Allocation reason / source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry) => {
                            const raw = sourceEntries.get(entry.sourceEntryId);
                            const artifact = raw ? imports.get(raw.importId) : undefined;
                            return (
                              <tr key={entry.sourceEntryId}>
                                <td>
                                  {entry.workerName}
                                  <small>{shortDate(entry.date)}</small>
                                </td>
                                <td>
                                  {raw?.jobName ?? "Source unavailable"}
                                  <small>
                                    {raw?.clockIn || "—"} – {raw?.clockOut || "—"} ·{" "}
                                    {entry.sourceKind}
                                  </small>
                                  <small>
                                    Original cost: {sourceMoney(raw?.laborCostCents ?? null)}
                                  </small>
                                </td>
                                <td className={styles.number}>{hours(entry.allocatedHours)}</td>
                                <td>
                                  {allocationReason(entry.reason)}
                                  {entry.jobMapping && (
                                    <small>
                                      Housecall link:{" "}
                                      {entry.jobMapping.method === "reviewed"
                                        ? "manager confirmed"
                                        : "exact customer and address"}{" "}
                                      · {shortDate(entry.jobMapping.fromDate)} –{" "}
                                      {shortDate(entry.jobMapping.toDate)}
                                    </small>
                                  )}
                                  {entry.destinationSourceKey &&
                                    entry.destinationSourceKey !== entry.sourceJobKey && (
                                      <small>
                                        Resolved source destination: {entry.destinationSourceKey}
                                      </small>
                                    )}
                                  {artifact && (
                                    <small>
                                      <a href={artifact.originalUrl}>
                                        All Entries · row {entry.sourceRow}
                                      </a>
                                    </small>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <div className={styles.footer}>
                    Job hours use the allocated intervals. Daily lunch remains a worker-day
                    adjustment. Weekly pay estimates are available in Labor Hours. Review the
                    estimated paid hours and labor cost below before approving this job’s hours.
                  </div>
                </>
              )}
            </div>
          </section>
          {selected && (
            <LaborApprovalWorkspace
              key={selected.key}
              job={selected}
              initialFrom={from || approvalDates[0] || sourceDates[0] || ""}
              initialTo={to || approvalDates.at(-1) || sourceDates.at(-1) || ""}
              refreshToken={approvalRefresh}
            />
          )}
          <section className={styles.card} aria-label="Pending labor allocation">
            <div className={styles.cardHeader}>
              <div>
                <h2>Hours awaiting allocation</h2>
                <p>{pending.length} unassigned source intervals across all jobs in these filters</p>
              </div>
              <Link className={styles.textButton} href="/labor-hours?allocation=pending">
                Full review queue
              </Link>
            </div>
            {pending.length === 0 ? (
              <div className={styles.empty}>No pending intervals in these filters.</div>
            ) : (
              <>
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Worker / date</th>
                        <th>Source location</th>
                        <th className={styles.number}>Pending hours</th>
                        <th>Review reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.slice(0, 50).map((entry) => {
                        const raw = sourceEntries.get(entry.sourceEntryId);
                        const artifact = raw ? imports.get(raw.importId) : undefined;
                        return (
                          <tr key={entry.sourceEntryId}>
                            <td>
                              {entry.workerName}
                              <small>{shortDate(entry.date)}</small>
                            </td>
                            <td>
                              {raw?.jobName ?? "Source unavailable"}
                              {artifact && (
                                <small>
                                  <a href={artifact.originalUrl}>
                                    All Entries · row {entry.sourceRow}
                                  </a>
                                </small>
                              )}
                            </td>
                            <td className={styles.number}>{hours(entry.pendingHours)}</td>
                            <td>
                              {allocationReason(entry.reason)}
                              <small>{entry.reviewReasons.map(allocationReason).join(" · ")}</small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {pending.length > 50 && (
                  <p className={styles.footer}>
                    Showing the first 50 of {pending.length} intervals. Open the full review queue
                    to see all decisions.
                  </p>
                )}
              </>
            )}
          </section>
          <section className={styles.card} aria-label="Unassigned receipts">
            <div className={styles.cardHeader}>
              <h2>Receipts awaiting a job</h2>
              <p>{unassignedReceipts.length} in selected dates</p>
            </div>
            {unassignedReceipts.length === 0 ? (
              <div className={styles.empty}>No unassigned receipts in the selected dates.</div>
            ) : (
              <ReceiptTable receipts={unassignedReceipts} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function ReceiptTable({ receipts }: { receipts: JobReceiptActivity[] }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Submitted</th>
            <th>Status</th>
            <th className={styles.number}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr key={receipt.id}>
              <td>
                <strong>
                  {receipt.href ? (
                    <Link href={receipt.href}>{receipt.vendor || "Vendor unavailable"}</Link>
                  ) : (
                    receipt.vendor || "Vendor unavailable"
                  )}
                </strong>
                <small>{receipt.reference || receipt.id}</small>
                {receipt.developmentFixture && <small>Development fixture</small>}
              </td>
              <td className={styles.nowrap}>{localTime(receipt.submittedAt)}</td>
              <td>{receipt.status.replaceAll("_", " ")}</td>
              <td className={styles.number}>{sourceMoney(receipt.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
