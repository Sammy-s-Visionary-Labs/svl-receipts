"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LaborDashboardData } from "@/lib/labor/contract";
import {
  type AllocationFilters,
  allocatedJobRows,
  allocationReason,
  EMPTY_ALLOCATION_FILTERS,
  filterAllocationEntries,
  filterWorkerDays,
  laborNoteMatchesWorker,
} from "./allocation-view";
import styles from "./labor.module.css";
import { hours, localTime, readApi, shortDate, sourceMoney } from "./labor-view";
import { LaborRulesEditor } from "./rules-editor";

type AllocationTab = "days" | "jobs" | "entries" | "notes" | "rules";
const tabs: { value: AllocationTab; label: string }[] = [
  { value: "days", label: "Worker days" },
  { value: "jobs", label: "Job hours" },
  { value: "entries", label: "Entry decisions" },
  { value: "notes", label: "Daily comments" },
  { value: "rules", label: "Location rules" },
];

export function AllocationWorkspace({
  data,
  onChanged,
}: {
  data: LaborDashboardData;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<AllocationTab>("days");
  const [filters, setFilters] = useState<AllocationFilters>(EMPTY_ALLOCATION_FILTERS);
  const [page, setPage] = useState(0);
  const [busyNote, setBusyNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("allocation") === "pending") {
      setTab("entries");
      setFilters((current) => ({ ...current, status: "pending" }));
    }
  }, []);
  const report = data.allocation;
  const workerAliases = data.paySettings.workerAliases;
  const decisions = filterAllocationEntries(report.entries, filters, workerAliases);
  const days = filterWorkerDays(report.workerDays, filters);
  const jobs = allocatedJobRows(
    filterAllocationEntries(report.entries, { ...filters, status: "" }, workerAliases),
    workerAliases,
  );
  const source = new Map(data.entries.map((entry) => [entry.id, entry]));
  const imports = new Map(data.imports.map((item) => [item.id, item]));
  const noteImports = new Map(data.notesImports.map((item) => [item.id, item]));
  const notes = data.notes.filter(
    (note) =>
      note.kind === "daily_candidate" &&
      laborNoteMatchesWorker(
        note.workerName,
        filters.worker,
        data.rules.workerAliases,
        workerAliases,
      ) &&
      (!filters.from || (note.date !== null && note.date >= filters.from)) &&
      (!filters.to || (note.date !== null && note.date <= filters.to)),
  );
  const daySum = (
    key:
      | "grossHours"
      | "lunchAdjustmentHours"
      | "netHours"
      | "allocatedHours"
      | "excludedHours"
      | "pendingHours",
  ) => days.reduce((sum, day) => sum + Math.round(day[key] * 100), 0) / 100;
  const pages = Math.max(1, Math.ceil(decisions.length / 50));
  const safePage = Math.min(page, pages - 1);
  const visibleDecisions = decisions.slice(safePage * 50, safePage * 50 + 50);

  function filter(key: keyof AllocationFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }

  async function verifyNote(noteId: string, dailyVerified: boolean) {
    setBusyNote(noteId);
    setError("");
    try {
      await readApi(
        await fetch("/api/manager/labor/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noteId, dailyVerified }),
        }),
      );
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update comment verification.");
    } finally {
      setBusyNote("");
    }
  }

  return (
    <section aria-label="Labor allocation">
      <p className={styles.notice}>
        Materials under Housecall Job Inputs is the intended destination. This is an allocation
        preview; nothing is posted. Job hours retain their full allocated intervals. Lunch is
        deducted once from each qualifying worker day.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={`${styles.metrics} ${styles.allocationMetrics}`}>
        {[
          {
            label: "Gross worker-day hours",
            value: daySum("grossHours"),
            note: "All locations and travel",
          },
          {
            label: "Policy lunch adjustment",
            value: daySum("lunchAdjustmentHours"),
            note: "30 minutes at 6 gross hours",
          },
          {
            label: "Net worker-day hours",
            value: daySum("netHours"),
            note: "Gross plus the lunch adjustment",
          },
          {
            label: "Allocated to customer jobs",
            value: daySum("allocatedHours"),
            note: "Before the daily lunch deduction",
          },
          {
            label: "Excluded job hours",
            value: daySum("excludedHours"),
            note: "Still part of the complete day",
          },
          {
            label: "Pending allocation",
            value: daySum("pendingHours"),
            note: "Needs evidence or classification",
          },
        ].map((metric) => (
          <div className={styles.metric} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{hours(metric.value)}</strong>
            <small>{metric.note}</small>
          </div>
        ))}
      </div>
      {report.warnings.length > 0 && (
        <details className={styles.warnings}>
          <summary>{report.warnings.length} allocation notes</summary>
          <ul>
            {report.warnings.map((warning) => (
              <li key={warning}>{allocationReason(warning)}</li>
            ))}
          </ul>
        </details>
      )}
      <div className={styles.filters}>
        <label>
          Allocation worker
          <select value={filters.worker} onChange={(event) => filter("worker", event.target.value)}>
            <option value="">All workers</option>
            {[...new Set(report.workerDays.map((day) => day.workerName))].sort().map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Allocation from
          <input
            type="date"
            value={filters.from}
            onChange={(event) => filter("from", event.target.value)}
          />
        </label>
        <label>
          Allocation through
          <input
            type="date"
            min={filters.from || undefined}
            value={filters.to}
            onChange={(event) => filter("to", event.target.value)}
          />
        </label>
        <label>
          Entry decision
          <select value={filters.status} onChange={(event) => filter("status", event.target.value)}>
            <option value="">All decisions</option>
            <option value="allocated">Allocated</option>
            <option value="excluded">Excluded</option>
            <option value="pending">Pending review</option>
            <option value="day_adjustment">Source day adjustment</option>
          </select>
        </label>
      </div>
      <div className={styles.filterActions}>
        <span>
          Worker-day totals always use the complete day. The decision filter applies to entry
          decisions.
        </span>
        <a href="/api/manager/labor?format=days">All worker days CSV</a>
        <a href="/api/manager/labor?format=allocations">All entry decisions CSV</a>
        <button
          className={styles.textButton}
          type="button"
          onClick={() => {
            setFilters(EMPTY_ALLOCATION_FILTERS);
            setPage(0);
          }}
        >
          Clear allocation filters
        </button>
      </div>
      <section className={styles.card}>
        <fieldset className={styles.tabs} aria-label="Allocation views">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              className={`${styles.tab} ${tab === item.value ? styles.selectedTab : ""}`}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        {tab === "days" &&
          (days.length === 0 ? (
            <div className={styles.empty}>No worker days in these filters.</div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Worker / work date</th>
                    <th className={styles.number}>Gross</th>
                    <th className={styles.number}>Lunch</th>
                    <th className={styles.number}>Net</th>
                    <th className={styles.number}>Job hours</th>
                    <th className={styles.number}>Excluded</th>
                    <th className={styles.number}>Pending</th>
                    <th>Source breaks / review</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.key}>
                      <td>
                        <strong>{day.workerName}</strong>
                        <small>{shortDate(day.date)}</small>
                      </td>
                      <td className={styles.number}>{hours(day.grossHours)}</td>
                      <td className={styles.number}>{hours(day.lunchAdjustmentHours)}</td>
                      <td className={styles.number}>{hours(day.netHours)}</td>
                      <td className={styles.number}>{hours(day.allocatedHours)}</td>
                      <td className={styles.number}>{hours(day.excludedHours)}</td>
                      <td className={styles.number}>{hours(day.pendingHours)}</td>
                      <td>
                        <small>
                          Source break: {hours(day.sourceBreakHours)} h · difference:{" "}
                          {hours(day.breakDifferenceHours)} h
                        </small>
                        {day.reviewReasons.length > 0 ? (
                          <details className={styles.reviewDetails}>
                            <summary>{day.reviewReasons.length} review items</summary>
                            <ul>
                              {day.reviewReasons.map((reason) => (
                                <li key={reason}>{allocationReason(reason)}</li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          <small>No review items</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === "jobs" &&
          (jobs.length === 0 ? (
            <div className={styles.empty}>
              No customer job hours are resolved yet. Review locations and pending entries.
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Allocated destination</th>
                    <th className={styles.number}>Hours</th>
                    <th>Entries</th>
                    <th>Workers</th>
                    <th>Cost / destination</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((group) => (
                    <tr key={group.job.key}>
                      <td>
                        <Link href={`/jobs?job=${encodeURIComponent(group.job.key)}`}>
                          {group.job.name}
                        </Link>
                        <small>{group.job.address}</small>
                      </td>
                      <td className={styles.number}>{hours(group.hours)}</td>
                      <td>{group.entryCount}</td>
                      <td>{group.workers.size}</td>
                      <td>
                        Review estimated labor cost in Jobs
                        <small>
                          Manager approval includes paid hours, lunch and overtime treatment.
                        </small>
                        <small>
                          {group.job.housecallJobId
                            ? `Housecall ${group.job.housecallJobId}`
                            : "Housecall job link pending"}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === "entries" &&
          (decisions.length === 0 ? (
            <div className={styles.empty}>No decisions in these filters.</div>
          ) : (
            <>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Worker / date</th>
                      <th>Original source</th>
                      <th>Allocation</th>
                      <th className={styles.number}>Hours</th>
                      <th>Reason / evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDecisions.map((decision) => {
                      const raw = source.get(decision.sourceEntryId);
                      const artifact = raw ? imports.get(raw.importId) : undefined;
                      return (
                        <tr key={decision.sourceEntryId}>
                          <td>
                            <strong>{decision.workerName}</strong>
                            <small>{shortDate(decision.date)}</small>
                          </td>
                          <td>
                            {raw?.jobName ?? "Source entry unavailable"}
                            <small>
                              {raw?.clockIn || "—"} – {raw?.clockOut || "—"} ·{" "}
                              {decision.sourceKind.replaceAll("_", " ")}
                            </small>
                            <small>
                              {hours(decision.sourceHours)} h · reported cost{" "}
                              {sourceMoney(raw?.laborCostCents ?? null)}
                            </small>
                            {artifact && (
                              <a href={artifact.originalUrl}>
                                All Entries · row {decision.sourceRow}
                              </a>
                            )}
                          </td>
                          <td>
                            {decision.status === "allocated" && decision.job ? (
                              <Link href={`/jobs?job=${encodeURIComponent(decision.job.key)}`}>
                                {decision.job.name}
                              </Link>
                            ) : decision.status === "pending" ? (
                              "Pending review"
                            ) : decision.status === "excluded" ? (
                              "Excluded from job hours"
                            ) : (
                              "Worker-day adjustment"
                            )}
                          </td>
                          <td className={styles.number}>
                            {hours(
                              decision.allocatedHours ||
                                decision.excludedHours ||
                                decision.pendingHours ||
                                decision.sourceHours,
                            )}
                          </td>
                          <td>
                            {allocationReason(decision.reason)}
                            {decision.reviewReasons.length > 0 && (
                              <details className={styles.reviewDetails}>
                                <summary>Review reasons</summary>
                                <ul>
                                  {decision.reviewReasons.map((reason) => (
                                    <li key={reason}>{allocationReason(reason)}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                            {decision.noteIds.map((id) => {
                              const note = data.notes.find((item) => item.id === id);
                              const noteArtifact = note
                                ? noteImports.get(note.importId)
                                : undefined;
                              return (
                                <small key={id}>
                                  Comment evidence: {note?.date ?? "date unverified"} ·{" "}
                                  {noteArtifact ? (
                                    <a href={noteArtifact.originalUrl}>
                                      Notes row {note?.sourceRow}
                                    </a>
                                  ) : (
                                    `row ${note?.sourceRow ?? "unavailable"}`
                                  )}
                                </small>
                              );
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.footer}>
                <span>
                  {decisions.length} entry decisions · original quantities and costs retained
                </span>
                {pages > 1 && (
                  <div className={styles.pagination}>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      {safePage + 1} / {pages}
                    </span>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={safePage >= pages - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            </>
          ))}
        {tab === "notes" && (
          <div className={styles.cardBody}>
            <p className={styles.muted}>
              Only daily job-comment candidates are shown. Confirm the note type and review a job
              alias before a mixed-report comment can correct abnormal travel. Other original report
              records remain in the source file.
            </p>
            {notes.length === 0 ? (
              <div className={styles.empty}>
                No daily job-comment candidates in these filters. Missing notes are not treated as
                proof of an empty day.
              </div>
            ) : (
              notes.map((note) => {
                const artifact = noteImports.get(note.importId);
                return (
                  <article className={styles.importItem} key={note.id}>
                    <div className={styles.importHeading}>
                      <strong>
                        {note.workerName} ·{" "}
                        {note.date ? shortDate(note.date) : "Work date unverified"}
                      </strong>
                      {artifact && (
                        <a href={artifact.originalUrl}>Notes Report · row {note.sourceRow}</a>
                      )}
                    </div>
                    <p className={styles.noteText}>{note.text}</p>
                    <p>
                      {artifact?.notesScope === "daily_timesheet"
                        ? "Daily Timesheet Note report"
                        : "Mixed report candidate"}{" "}
                      ·{" "}
                      {note.dailyVerified
                        ? "daily comment confirmed"
                        : "daily comment type not confirmed"}{" "}
                      · raw date {note.rawDate}
                    </p>
                    <div className={styles.actions}>
                      <button
                        className={styles.button}
                        type="button"
                        disabled={
                          Boolean(busyNote) || (!note.dailyVerified && !artifact?.datesVerified)
                        }
                        onClick={() => void verifyNote(note.id, !note.dailyVerified)}
                      >
                        {busyNote === note.id
                          ? "Saving…"
                          : note.dailyVerified
                            ? "Revoke daily-comment confirmation"
                            : "Confirm daily job comment"}
                      </button>
                    </div>
                    {!note.dailyVerified && !artifact?.datesVerified && (
                      <p className={styles.muted}>
                        Verify this report’s work dates against Supercrew, then re-upload with
                        work-date verification checked before confirming the daily comment.
                      </p>
                    )}
                  </article>
                );
              })
            )}
            <h3 className={styles.sectionLabel}>Notes import coverage</h3>
            {data.notesImports.length === 0 ? (
              <p className={styles.muted}>No Notes Report has been imported.</p>
            ) : (
              data.notesImports.map((item) => (
                <article className={styles.importItem} key={item.id}>
                  <div className={styles.importHeading}>
                    <strong>{item.filename}</strong>
                    <a href={item.originalUrl}>Original notes Excel</a>
                  </div>
                  <p>
                    Declared period {shortDate(item.period.from)} – {shortDate(item.period.to)} ·{" "}
                    {item.notesCount} records · imported {localTime(item.importedAt)}
                  </p>
                  <p>
                    {item.notesScope === "daily_timesheet"
                      ? "Daily note scope"
                      : "Mixed note types"}{" "}
                    ·{" "}
                    {item.complete
                      ? "all workers/jobs declared complete"
                      : "complete coverage not declared"}{" "}
                    ·{" "}
                    {item.datesVerified
                      ? "work-date interpretation verified"
                      : "work dates need verification"}
                  </p>
                  {item.warnings.length > 0 && (
                    <details className={styles.reviewDetails}>
                      <summary>{item.warnings.length} import notes</summary>
                      <ul>
                        {item.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              ))
            )}
          </div>
        )}
        {tab === "rules" && (
          <LaborRulesEditor
            entries={data.entries}
            rules={data.rules}
            revision={data.rulesRevision}
            onSaved={onChanged}
          />
        )}
      </section>
    </section>
  );
}
