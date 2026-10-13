"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { LaborDashboardData } from "@/lib/labor/contract";
import styles from "./labor.module.css";
import { hours, readApi, shortDate, sourceMoney } from "./labor-view";
import { parseHourlyRateCents } from "./pay-view";

type PaySettings = LaborDashboardData["paySettings"];
type RateDraft = { workerName: string; rate: string; active: boolean };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const rateDrafts = (settings: PaySettings): RateDraft[] =>
  settings.workerRates.map((worker) => ({
    workerName: worker.workerName,
    rate: worker.hourlyRateCents === null ? "" : (worker.hourlyRateCents / 100).toFixed(2),
    active: worker.active,
  }));

export function LaborPayWorkspace({
  settings,
  revision,
  payroll,
  onSaved,
}: {
  settings: PaySettings;
  revision: number;
  payroll: LaborDashboardData["payroll"];
  onSaved: () => Promise<void>;
}) {
  const [rates, setRates] = useState(() => rateDrafts(settings));
  const [threshold, setThreshold] = useState(String(settings.overtime.thresholdHours));
  const [multiplier, setMultiplier] = useState(String(settings.overtime.multiplier));
  const [weekStartsOn, setWeekStartsOn] = useState(settings.overtime.weekStartsOn);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const weeks = [...payroll.workerWeeks].sort(
    (a, b) => b.weekStart.localeCompare(a.weekStart) || a.workerName.localeCompare(b.workerName),
  );
  const incompleteWeeks = weeks.filter((week) => !week.complete).length;
  const missingRates = new Set(
    weeks.filter((week) => week.hourlyRateCents === null).map((week) => week.workerName),
  ).size;
  const weekEndsOn = (settings.overtime.weekStartsOn + 6) % 7;

  useEffect(() => {
    // Imports can add workers without changing the saved pay revision.
    // Preserve draft edits while making newly imported workers editable.
    setRates((current) => {
      const added = rateDrafts(settings).filter(
        (worker) => !current.some((draft) => draft.workerName === worker.workerName),
      );
      return added.length ? [...current, ...added] : current;
    });
  }, [settings]);

  function applySettings(latest: PaySettings, latestRevision: number) {
    setRates(rateDrafts(latest));
    setThreshold(String(latest.overtime.thresholdHours));
    setMultiplier(String(latest.overtime.multiplier));
    setWeekStartsOn(latest.overtime.weekStartsOn);
    setBaseRevision(latestRevision);
    setError("");
  }

  function updateRate(workerName: string, change: Partial<RateDraft>) {
    setRates((current) =>
      current.map((worker) =>
        worker.workerName === workerName ? { ...worker, ...change } : worker,
      ),
    );
    setNotice("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const workerRates = rates.map((worker) => {
        try {
          return {
            workerName: worker.workerName,
            hourlyRateCents: parseHourlyRateCents(worker.rate),
            active: worker.active,
          };
        } catch (cause) {
          throw new Error(
            `${worker.workerName}: ${cause instanceof Error ? cause.message : "Invalid rate."}`,
          );
        }
      });
      const thresholdHours = Number(threshold);
      const overtimeMultiplier = Number(multiplier);
      if (!Number.isFinite(thresholdHours) || thresholdHours <= 0 || thresholdHours > 168)
        throw new Error(
          "Enter an overtime threshold greater than zero and no more than 168 hours.",
        );
      if (!Number.isFinite(overtimeMultiplier) || overtimeMultiplier < 1 || overtimeMultiplier > 10)
        throw new Error("Enter an overtime multiplier from 1 to 10.");
      const payload: PaySettings = {
        workerRates,
        overtime: { thresholdHours, multiplier: overtimeMultiplier, weekStartsOn },
      };
      const result = await readApi<{ settings: PaySettings; payRevision: number }>(
        await fetch("/api/manager/labor/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: payload, expectedRevision: baseRevision }),
        }),
      );
      applySettings(result.settings, result.payRevision);
      setNotice("Pay settings saved. Weekly estimates now use these rates and overtime rules.");
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save pay settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="weekly-pay-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="weekly-pay-title">Weekly pay estimates</h2>
          <p>
            {WEEKDAYS[settings.overtime.weekStartsOn]}–{WEEKDAYS[weekEndsOn]} weeks · overtime after{" "}
            {hours(settings.overtime.thresholdHours)} hours at {settings.overtime.multiplier}×
          </p>
        </div>
        <span className={styles.badge}>Estimate</span>
      </div>
      <div className={styles.cardBody}>
        <p className={styles.muted}>
          Current saved rates apply to all imported worker hours after the daily lunch adjustment,
          including time excluded from customer jobs. Incomplete weeks reflect only hours imported
          so far. These are planning estimates; original Supercrew costs and payroll records stay
          unchanged.
        </p>
        <div className={`${styles.metrics} ${styles.payMetrics}`}>
          <div className={styles.metric}>
            <span>Paid hours in imported weeks</span>
            <strong>{hours(payroll.totals.paidHours)}</strong>
            <small>
              {hours(payroll.totals.regularHours)} regular · {hours(payroll.totals.overtimeHours)}{" "}
              overtime
            </small>
          </div>
          <div className={styles.metric}>
            <span>Estimated pay at known rates</span>
            <strong>{sourceMoney(payroll.totals.knownEstimatedPayCents)}</strong>
            <small>
              {weeks.length === 0
                ? "No imported weeks yet"
                : incompleteWeeks > 0
                  ? "Includes incomplete imported weeks"
                  : "All shown weeks have complete coverage"}
            </small>
          </div>
          <div className={styles.metric}>
            <span>Hours without a confirmed rate</span>
            <strong>{hours(payroll.totals.unpricedHours)}</strong>
            <small>{missingRates} workers with missing rates</small>
          </div>
        </div>
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
        <details className={styles.paySettings}>
          <summary>Edit worker rates and overtime</summary>
          <form onSubmit={(event) => void save(event)}>
            <p className={styles.muted} id="pay-rate-guidance">
              Leave an hourly rate blank until it is confirmed. The Active worker checkbox records
              roster status. Inactive workers retain imported historical hours and pay estimates.
            </p>
            {revision !== baseRevision && (
              <div role="alert" className={styles.error}>
                Saved pay settings changed while you were editing.{" "}
                <button
                  className={styles.textButton}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    applySettings(settings, revision);
                    setNotice("Latest saved pay settings loaded.");
                  }}
                >
                  Use latest saved settings
                </button>
              </div>
            )}
            <fieldset className={styles.payFields} disabled={busy}>
              <legend>Weekly overtime</legend>
              <label>
                Overtime after (hours)
                <input
                  type="number"
                  min="0.01"
                  max="168"
                  step="0.01"
                  required
                  value={threshold}
                  onChange={(event) => {
                    setThreshold(event.target.value);
                    setNotice("");
                  }}
                />
              </label>
              <label>
                Overtime multiplier
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="0.01"
                  required
                  value={multiplier}
                  onChange={(event) => {
                    setMultiplier(event.target.value);
                    setNotice("");
                  }}
                />
              </label>
              <label>
                Week starts on
                <select
                  aria-label="Week starts on"
                  value={weekStartsOn}
                  onChange={(event) => {
                    setWeekStartsOn(Number(event.target.value));
                    setNotice("");
                  }}
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Worker</th>
                    <th scope="col">Hourly rate ($/hour)</th>
                    <th scope="col">Roster status</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((worker) => (
                    <tr key={worker.workerName}>
                      <td>
                        <strong>{worker.workerName}</strong>
                      </td>
                      <td>
                        <input
                          aria-label={`Hourly rate in dollars for ${worker.workerName}`}
                          aria-describedby="pay-rate-guidance"
                          className={styles.rateInput}
                          type="number"
                          min="0"
                          max="10000"
                          step="0.01"
                          inputMode="decimal"
                          placeholder="Unspecified"
                          value={worker.rate}
                          disabled={busy}
                          onChange={(event) =>
                            updateRate(worker.workerName, { rate: event.target.value })
                          }
                        />
                        {worker.rate === "" && <small>Rate not confirmed</small>}
                      </td>
                      <td>
                        <label className={styles.activeWorker}>
                          <input
                            type="checkbox"
                            checked={worker.active}
                            disabled={busy}
                            aria-label={`Active worker: ${worker.workerName}`}
                            onChange={(event) =>
                              updateRate(worker.workerName, { active: event.target.checked })
                            }
                          />
                          Active worker
                        </label>
                        {!worker.active && <small>Historical hours retained</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`${styles.actions} ${styles.paySave}`}>
              <button
                className={styles.primary}
                type="submit"
                disabled={busy || revision !== baseRevision}
              >
                {busy ? "Saving pay settings…" : "Save pay settings"}
              </button>
              <span className={styles.muted}>Revision {baseRevision} · saved pay settings</span>
            </div>
          </form>
        </details>
      </div>
      {weeks.length === 0 ? (
        <div className={styles.empty}>Import worker hours to see weekly pay estimates.</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Worker / week</th>
                <th scope="col" className={styles.number}>
                  Paid hours
                </th>
                <th scope="col" className={styles.number}>
                  Regular hours
                </th>
                <th scope="col" className={styles.number}>
                  Overtime hours
                </th>
                <th scope="col" className={styles.number}>
                  Hourly rate
                </th>
                <th scope="col" className={styles.number}>
                  Regular pay
                </th>
                <th scope="col" className={styles.number}>
                  Overtime pay
                </th>
                <th scope="col" className={styles.number}>
                  Estimated pay
                </th>
                <th scope="col">Import coverage</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={`${week.workerName}:${week.weekStart}`}>
                  <td>
                    <strong>{week.workerName}</strong>
                    <small>
                      {shortDate(week.weekStart)} – {shortDate(week.weekEnd)}
                    </small>
                    {!week.active && <small>Inactive · historical hours</small>}
                  </td>
                  <td className={styles.number}>
                    {hours(week.paidHours)}
                    <small>
                      {hours(week.grossHours)} gross − {hours(Math.abs(week.lunchAdjustmentHours))}{" "}
                      lunch
                    </small>
                  </td>
                  <td className={styles.number}>{hours(week.regularHours)}</td>
                  <td className={styles.number}>{hours(week.overtimeHours)}</td>
                  <td className={styles.number}>
                    {week.hourlyRateCents === null
                      ? "Unspecified"
                      : sourceMoney(week.hourlyRateCents)}
                  </td>
                  <td className={styles.number}>
                    {week.regularPayCents === null
                      ? "Rate missing"
                      : sourceMoney(week.regularPayCents)}
                  </td>
                  <td className={styles.number}>
                    {week.overtimePayCents === null
                      ? "Rate missing"
                      : sourceMoney(week.overtimePayCents)}
                  </td>
                  <td className={styles.number}>
                    <strong>
                      {week.estimatedPayCents === null
                        ? "Rate missing"
                        : sourceMoney(week.estimatedPayCents)}
                    </strong>
                  </td>
                  <td>
                    {week.complete ? "Complete week" : "Incomplete week"}
                    {!week.complete && <small>Imported hours so far</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.footer}>
        Weekly estimates cover all imported workers and dates. Job approval reviews distribute lunch
        and weekly overtime across source intervals to estimate each linked job’s labor cost.
      </div>
    </section>
  );
}
