"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { LaborDashboardData, LaborSyncState } from "@/lib/labor/contract";
import { Icon } from "../manager/icons";
import { AllocationWorkspace } from "./allocation-workspace";
import { LaborJobMappingEditor } from "./job-mapping-editor";
import styles from "./labor.module.css";
import {
  EMPTY_LABOR_FILTERS,
  filterLaborEntries,
  hours,
  type LaborFilters,
  localTime,
  readApi,
  shortDate,
  sourceMoney,
  summarizeEntries,
} from "./labor-view";
import { NotesUpload } from "./notes-upload";
import { LaborPayWorkspace } from "./pay-settings";

type View = "entries" | "workers" | "jobs";
const DAILY_HOURS = Array.from({ length: 24 }, (_, value) => value);
const syncLabels: Record<LaborSyncState["status"], string> = {
  not_connected: "Not connected",
  idle: "Ready",
  running: "Downloading report",
  needs_login: "Sign-in required",
  failed: "Needs attention",
};

export function LaborDashboard() {
  const [data, setData] = useState<LaborDashboardData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [filters, setFilters] = useState<LaborFilters>(EMPTY_LABOR_FILTERS);
  const [view, setView] = useState<View>("entries");
  const [workspaceView, setWorkspaceView] = useState<"allocation" | "source">("allocation");
  const [page, setPage] = useState(0);
  const [hour, setHour] = useState(6);
  const [lookback, setLookback] = useState(14);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const dataRevision = useRef<string | null>(null);
  const loading = useRef(false);
  const statusBusy = useRef(false);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    loading.current = true;
    try {
      const result = await readApi<LaborDashboardData>(
        await fetch("/api/manager/labor", {
          cache: "no-store",
        }),
      );
      if (current !== sequence.current) return;
      dataRevision.current = result.dataRevision;
      setData(result);
      setError("");
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not load labor hours.");
    } finally {
      if (current === sequence.current) loading.current = false;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    if (document.visibilityState === "hidden" || loading.current || statusBusy.current) return;
    const current = sequence.current;
    statusBusy.current = true;
    try {
      const status = await readApi<{ sync: LaborSyncState; dataRevision: string }>(
        await fetch("/api/manager/labor/status", { cache: "no-store" }),
      );
      if (current !== sequence.current) return;
      if (typeof status.dataRevision !== "string")
        throw new Error("Could not refresh labor status.");
      setData((previous) => (previous ? { ...previous, sync: status.sync } : previous));
      if (status.dataRevision !== dataRevision.current) await load();
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not refresh labor status.");
    } finally {
      statusBusy.current = false;
    }
  }, [load]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    setFilters((current) => ({ ...current, job: search.get("job") ?? "" }));
    if (search.has("sourceJob")) {
      setWorkspaceView("source");
      setFilters((current) => ({ ...current, job: search.get("sourceJob") ?? "" }));
    }
    void load();
    const interval = window.setInterval(() => void pollStatus(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      sequence.current++;
    };
  }, [load, pollStatus]);

  const syncHour = data?.sync.hour;
  const syncLookback = data?.sync.lookbackDays;
  useEffect(() => {
    if (syncHour !== undefined) setHour(syncHour);
    if (syncLookback !== undefined) setLookback(syncLookback);
  }, [syncHour, syncLookback]);

  function changeFilter(key: keyof LaborFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }

  async function importWorkbook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file);
      await readApi(await fetch("/api/manager/labor/import", { method: "POST", body: form }));
      if (fileInput.current) fileInput.current.value = "";
      setNotice("Workbook checked. The hours and import history are up to date.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this workbook.");
    } finally {
      setBusy("");
    }
  }

  async function syncAction(action: "connect" | "run" | "pause" | "resume") {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const result = await readApi<{ sync: LaborSyncState; dispatch?: { message: string } }>(
        await fetch("/api/manager/labor/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, hour, lookbackDays: lookback }),
        }),
      );
      setData((previous) => (previous ? { ...previous, sync: result.sync } : previous));
      setNotice(
        action === "connect"
          ? data?.development
            ? "Sign-in requested. Complete Supercrew sign-in in the connected worker browser."
            : "Worker sign-in requested. Complete normal Supercrew sign-in through the configured worker connection setup."
          : action === "run"
            ? (result.dispatch?.message ??
              "Download queued for the next worker check. Import history will update after both reports are verified.")
            : action === "pause"
              ? "Recurring downloads paused."
              : "Recurring download schedule saved.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update downloads.");
    } finally {
      setBusy("");
    }
  }

  const entries = filterLaborEntries(data?.entries ?? [], filters);
  const sums = summarizeEntries(entries, view === "jobs" ? "job" : "worker");
  const allRows = view === "entries" ? entries : sums;
  const pageCount = Math.max(1, Math.ceil(allRows.length / 50));
  const safePage = Math.min(page, pageCount - 1);
  const entryPage = entries.slice(safePage * 50, safePage * 50 + 50);
  const sumPage = sums.slice(safePage * 50, safePage * 50 + 50);
  const totalHours = entries.reduce((sum, entry) => sum + entry.hours, 0);
  const travelHours = entries.reduce((sum, entry) => sum + (entry.travel ? entry.hours : 0), 0);
  const sourceImports = new Map(data?.imports.map((item) => [item.id, item]) ?? []);
  const busySync = Boolean(busy) || data?.sync.status === "running";

  return (
    <main id="main-content" className={styles.main}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>SUPERCREW IMPORTS</p>
          <h1 className={styles.title}>Labor Hours</h1>
          <p className={styles.subtitle}>
            Review complete worker days, customer-job allocations, weekly pay estimates, and the
            original Supercrew hours.
          </p>
        </div>
        <div className={styles.actions}>
          {data?.development && <span className={styles.badge}>Development</span>}
          <button
            className={styles.button}
            type="button"
            onClick={() => void load()}
            disabled={Boolean(busy)}
          >
            <Icon name="refresh" size={16} /> Refresh
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className={styles.notice}>
          {notice}
        </div>
      )}
      {!data ? (
        <div className={styles.card}>
          <div className={styles.empty}>
            {error
              ? "Labor data is unavailable. Use Refresh to try again."
              : "Loading labor hours…"}
          </div>
        </div>
      ) : (
        <>
          <section className={styles.card} aria-label="Recurring Supercrew downloads">
            <div className={styles.cardBody}>
              <div className={styles.syncHeader}>
                <div>
                  <div className={styles.syncTitle}>
                    <Icon name="clock" size={19} />
                    <h2>Recurring downloads</h2>
                    <span className={styles.syncStatus}>{syncLabels[data.sync.status]}</span>
                  </div>
                  <p className={styles.subtitle}>
                    {data.sync.enabled ? "Daily schedule enabled" : "Daily schedule paused"} ·{" "}
                    {data.sync.timeZone} · previous {data.sync.lookbackDays} completed days
                  </p>
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    type="button"
                    disabled={busySync}
                    onClick={() => void syncAction("connect")}
                  >
                    {busy === "connect"
                      ? "Requesting…"
                      : data.development
                        ? "Connect Supercrew"
                        : "Request worker sign-in"}
                  </button>
                  <button
                    className={styles.primary}
                    type="button"
                    disabled={busySync || data.sync.command !== null}
                    onClick={() => void syncAction("run")}
                  >
                    {busy === "run"
                      ? "Queuing…"
                      : data.development
                        ? "Download now"
                        : "Queue download"}
                  </button>
                </div>
              </div>
              {!data.development && (
                <p className={styles.muted}>
                  Supercrew uses the isolated worker’s normal login. The person managing the worker
                  completes sign-in in its connection setup. Download requests are queued for the
                  next worker check.
                </p>
              )}
              <dl className={styles.syncMeta}>
                <div>
                  <dt>Last successful import</dt>
                  <dd>{localTime(data.sync.lastSuccessAt, data.sync.timeZone)}</dd>
                </div>
                <div>
                  <dt>Next scheduled download</dt>
                  <dd>
                    {data.sync.enabled
                      ? localTime(data.sync.nextRunAt, data.sync.timeZone)
                      : "Paused"}
                  </dd>
                </div>
                <div>
                  <dt>Worker last seen</dt>
                  <dd>{localTime(data.sync.workerHeartbeatAt, data.sync.timeZone)}</dd>
                </div>
              </dl>
              {data.sync.command && (
                <p role="status" className={styles.notice}>
                  {data.sync.command === "connect"
                    ? "Waiting for worker to open sign-in."
                    : "Waiting for worker to start download."}
                </p>
              )}
              {data.sync.lastError && <p className={styles.error}>{data.sync.lastError}</p>}
              <form
                className={styles.scheduleForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void syncAction("resume");
                }}
              >
                <label>
                  Daily start time
                  <select
                    aria-label="Daily start time"
                    value={hour}
                    onChange={(event) => setHour(Number(event.target.value))}
                    disabled={Boolean(busy)}
                    className={styles.button}
                  >
                    {DAILY_HOURS.map((value) => (
                      <option
                        key={value}
                        value={value}
                      >{`${value.toString().padStart(2, "0")}:00`}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Days to download
                  <input
                    type="number"
                    min={1}
                    max={31}
                    required
                    value={lookback}
                    onChange={(event) => setLookback(Number(event.target.value))}
                    disabled={Boolean(busy)}
                  />
                </label>
                <button className={styles.button} type="submit" disabled={Boolean(busy)}>
                  {data.sync.enabled ? "Save schedule" : "Enable daily downloads"}
                </button>
                {data.sync.enabled && (
                  <button
                    className={styles.textButton}
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void syncAction("pause")}
                  >
                    Pause downloads
                  </button>
                )}
                <span className={styles.muted}>
                  The connected worker must be running for downloads to occur.
                </span>
              </form>
            </div>
          </section>
          <fieldset
            className={`${styles.tabs} ${styles.workspaceTabs}`}
            aria-label="Labor hour views"
          >
            <button
              className={`${styles.tab} ${workspaceView === "allocation" ? styles.selectedTab : ""}`}
              aria-pressed={workspaceView === "allocation"}
              type="button"
              onClick={() => setWorkspaceView("allocation")}
            >
              Allocation preview
            </button>
            <button
              className={`${styles.tab} ${workspaceView === "source" ? styles.selectedTab : ""}`}
              aria-pressed={workspaceView === "source"}
              type="button"
              onClick={() => setWorkspaceView("source")}
            >
              Original source hours
            </button>
          </fieldset>
          {workspaceView === "allocation" ? (
            <AllocationWorkspace data={data} onChanged={load} />
          ) : (
            <>
              <section className={styles.metrics} aria-label="Filtered hours summary">
                <div className={styles.metric}>
                  <span>Total hours</span>
                  <strong>{hours(totalHours)}</strong>
                  <small>Travel included</small>
                </div>
                <div className={styles.metric}>
                  <span>Travel hours</span>
                  <strong>{hours(travelHours)}</strong>
                  <small>Part of total hours</small>
                </div>
                <div className={styles.metric}>
                  <span>Workers</span>
                  <strong>{new Set(entries.map((entry) => entry.workerName)).size}</strong>
                  <small>{entries.length} source entries</small>
                </div>
                <div className={styles.metric}>
                  <span>Source jobs</span>
                  <strong>{new Set(entries.map((entry) => entry.jobKey)).size}</strong>
                  <small>Imported source grouping</small>
                </div>
              </section>
              <section aria-label="Filter labor hours">
                <div className={styles.filters}>
                  <label>
                    Search
                    <input
                      type="search"
                      placeholder="Worker, job, address or crew"
                      value={filters.search}
                      onChange={(event) => changeFilter("search", event.target.value)}
                    />
                  </label>
                  <label>
                    Worker
                    <select
                      value={filters.worker}
                      onChange={(event) => changeFilter("worker", event.target.value)}
                    >
                      <option value="">All workers</option>
                      {[...new Set(data.entries.map((entry) => entry.workerName))]
                        .sort()
                        .map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Source job
                    <select
                      value={filters.job}
                      onChange={(event) => changeFilter("job", event.target.value)}
                    >
                      <option value="">All source jobs</option>
                      {data.sourceJobs
                        .filter((job) => job.entryCount > 0)
                        .map((job) => (
                          <option key={job.key} value={job.key}>
                            {job.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    From
                    <input
                      type="date"
                      value={filters.from}
                      onChange={(event) => changeFilter("from", event.target.value)}
                    />
                  </label>
                  <label>
                    Through
                    <input
                      type="date"
                      value={filters.to}
                      min={filters.from || undefined}
                      onChange={(event) => changeFilter("to", event.target.value)}
                    />
                  </label>
                </div>
                <div className={styles.filterActions}>
                  <span>
                    {entries.length} of {data.entries.length} entries shown
                  </span>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => {
                        setFilters(EMPTY_LABOR_FILTERS);
                        setPage(0);
                      }}
                    >
                      Clear filters
                    </button>
                    <a className={styles.textButton} href="/api/manager/labor?format=csv">
                      Download all entries as CSV
                    </a>
                  </div>
                </div>
              </section>
              <section className={styles.card} aria-label="Imported labor hours">
                <fieldset className={styles.tabs} aria-label="Group labor hours">
                  {(["entries", "workers", "jobs"] as const).map((item) => (
                    <button
                      type="button"
                      key={item}
                      aria-pressed={view === item}
                      className={`${styles.tab} ${view === item ? styles.selectedTab : ""}`}
                      onClick={() => {
                        setView(item);
                        setPage(0);
                      }}
                    >
                      {item === "entries"
                        ? "All entries"
                        : item === "workers"
                          ? "By worker"
                          : "By source job"}
                    </button>
                  ))}
                </fieldset>
                {allRows.length === 0 ? (
                  <div className={styles.empty}>
                    <strong>No hours found</strong>
                    {data.entries.length
                      ? "Try changing your filters."
                      : "Download or upload a Supercrew Excel report to begin."}
                  </div>
                ) : (
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <thead>
                        {view === "entries" ? (
                          <tr>
                            <th>Date / worker</th>
                            <th>Source job</th>
                            <th>Clock times</th>
                            <th>Type</th>
                            <th className={styles.number}>Hours</th>
                            <th className={styles.number}>Source cost</th>
                            <th>Source</th>
                          </tr>
                        ) : (
                          <tr>
                            <th>{view === "workers" ? "Worker" : "Source job"}</th>
                            <th>Entries</th>
                            <th>{view === "workers" ? "Source jobs" : "Workers"}</th>
                            <th className={styles.number}>Total hours</th>
                            <th className={styles.number}>Travel included</th>
                            <th className={styles.number}>Source cost</th>
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {view === "entries"
                          ? entryPage.map((entry) => (
                              <tr key={entry.id}>
                                <td>
                                  <strong>{entry.workerName}</strong>
                                  <small>{shortDate(entry.date)}</small>
                                  {entry.role && <small>{entry.role}</small>}
                                </td>
                                <td>
                                  {entry.jobName}
                                  <small>{entry.jobAddress}</small>
                                </td>
                                <td className={styles.nowrap}>
                                  {entry.clockIn || "—"} – {entry.clockOut || "—"}
                                  <small>{entry.crew}</small>
                                </td>
                                <td>
                                  {entry.kind === "unpaid_break"
                                    ? "Unpaid break"
                                    : entry.travel
                                      ? "Travel"
                                      : entry.timeEntryType || "Work"}
                                </td>
                                <td className={styles.number}>{hours(entry.hours)}</td>
                                <td className={styles.number}>
                                  {sourceMoney(entry.laborCostCents)}
                                  {entry.laborCostCents === 0 && <small>Rate may be missing</small>}
                                </td>
                                <td>
                                  <a
                                    href={
                                      sourceImports.get(entry.importId)?.originalUrl ??
                                      "#import-history"
                                    }
                                    className={styles.sourceRef}
                                  >
                                    All Entries · row {entry.sourceRow}
                                  </a>
                                  <small>{sourceImports.get(entry.importId)?.filename}</small>
                                </td>
                              </tr>
                            ))
                          : sumPage.map((group) => (
                              <tr key={group.key}>
                                <td>
                                  <strong>{view === "jobs" ? group.name : group.name}</strong>
                                  {group.address && <small>{group.address}</small>}
                                </td>
                                <td>{group.entryCount}</td>
                                <td>{view === "workers" ? group.jobs.size : group.workers.size}</td>
                                <td className={styles.number}>{hours(group.hours)}</td>
                                <td className={styles.number}>{hours(group.travelHours)}</td>
                                <td className={styles.number}>
                                  {sourceMoney(group.reportedCostCents)}
                                </td>
                              </tr>
                            ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className={styles.footer}>
                  <span>
                    Original source hours and costs remain unchanged. Allocation and weekly pay
                    estimates use separate calculations; customer-job cost allocation remains
                    pending.
                  </span>
                  {pageCount > 1 && (
                    <div className={styles.pagination}>
                      <button
                        className={styles.button}
                        type="button"
                        disabled={safePage === 0}
                        onClick={() => setPage(safePage - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        {safePage + 1} / {pageCount}
                      </span>
                      <button
                        className={styles.button}
                        type="button"
                        disabled={safePage === pageCount - 1}
                        onClick={() => setPage(safePage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
          <LaborJobMappingEditor data={data} onChanged={load} />
          <LaborPayWorkspace
            settings={data.paySettings}
            revision={data.payRevision}
            payroll={data.payroll}
            onSaved={load}
          />
          <section className={styles.card} aria-label="Upload Excel report">
            <div className={styles.cardHeader}>
              <div>
                <h2>Upload a report</h2>
                <p>Use a downloaded Supercrew Excel file when needed.</p>
              </div>
            </div>
            <div className={styles.cardBody}>
              <form className={styles.importFile} onSubmit={(event) => void importWorkbook(event)}>
                <label>
                  Supercrew workbook
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".xlsx"
                    required
                    disabled={Boolean(busy)}
                  />
                </label>
                <button className={styles.primary} type="submit" disabled={Boolean(busy)}>
                  {busy === "import" ? "Importing…" : "Import Excel"}
                </button>
              </form>
            </div>
          </section>
          <NotesUpload period={data.imports[0]?.period} onImported={load} />
          <section className={styles.card} id="import-history" aria-label="Import history">
            <div className={styles.cardHeader}>
              <h2>Import history</h2>
              <p>{data.imports.length} reports</p>
            </div>
            {data.imports.length === 0 ? (
              <div className={styles.empty}>No reports have been imported yet.</div>
            ) : (
              <div className={styles.history}>
                {data.imports.map((item) => (
                  <article className={styles.importItem} key={item.id}>
                    <div className={styles.importHeading}>
                      <strong>{item.filename}</strong>
                      <a href={item.originalUrl}>Original Excel</a>
                    </div>
                    <p>
                      {shortDate(item.period.from)} – {shortDate(item.period.to)} ·{" "}
                      {item.entryCount} entries · {item.workerCount} workers · {item.jobCount}{" "}
                      source jobs
                    </p>
                    <p>
                      {item.source === "supercrew" ? "Downloaded from Supercrew" : "Uploaded file"}{" "}
                      · imported {localTime(item.importedAt)} · report total{" "}
                      {hours(item.reportedHours)} h / entry total {hours(item.computedHours)} h
                    </p>
                    {item.warnings.length > 0 && (
                      <details className={styles.warnings}>
                        <summary>{item.warnings.length} import notes</summary>
                        <ul>
                          {item.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
