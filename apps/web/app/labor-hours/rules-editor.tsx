"use client";

import type { LaborAllocationRules, ReviewedLaborLocation } from "@svl/domain";
import { type FormEvent, useRef, useState } from "react";
import styles from "./labor.module.css";
import { type DisplayEntry, readApi } from "./labor-view";

type AliasDraft = LaborAllocationRules["jobAliases"][number] & { localId: string };
const aliasDrafts = (rules: LaborAllocationRules): AliasDraft[] =>
  rules.jobAliases.map((alias, index) => ({ ...alias, localId: `saved-${index}` }));

export function LaborRulesEditor({
  entries,
  rules,
  revision,
  onSaved,
}: {
  entries: DisplayEntry[];
  rules: LaborAllocationRules;
  revision: number;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(rules);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [aliases, setAliases] = useState(aliasDrafts(rules));
  const nextAlias = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locations = new Map<string, { sourceKey: string; name: string; address: string }>();
  for (const entry of entries)
    if (entry.kind !== "unpaid_break")
      locations.set(entry.jobKey, {
        sourceKey: entry.jobKey,
        name: entry.jobName,
        address: entry.jobAddress,
      });
  for (const location of draft.locations) {
    if (locations.has(location.sourceKey)) continue;
    let name = location.job?.name ?? location.sourceKey;
    let address = location.job?.address ?? "";
    try {
      const pair = JSON.parse(location.sourceKey);
      if (
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((value) => typeof value === "string")
      )
        [name, address] = pair;
    } catch {
      /* Older keys remain readable without guessing an identity. */
    }
    locations.set(location.sourceKey, { sourceKey: location.sourceKey, name, address });
  }
  const options = [...locations.values()].sort((a, b) => a.name.localeCompare(b.name));
  const customers = draft.locations.filter(
    (location) => location.kind === "customer" && location.job !== null,
  );

  function classify(sourceKey: string, kind: ReviewedLaborLocation["kind"]) {
    const source = locations.get(sourceKey);
    if (!source) return;
    setDraft((current) => {
      const previous = current.locations.find((location) => location.sourceKey === sourceKey);
      const location: ReviewedLaborLocation = {
        sourceKey,
        kind,
        job:
          kind === "customer"
            ? (previous?.job ?? {
                key: sourceKey,
                name: source.name,
                address: source.address,
                housecallJobId: null,
              })
            : null,
      };
      return {
        ...current,
        locations: [...current.locations.filter((item) => item.sourceKey !== sourceKey), location],
      };
    });
    setNotice("");
  }

  function useLatest() {
    setDraft(rules);
    setAliases(aliasDrafts(rules));
    setBaseRevision(revision);
    setError("");
    setNotice("Latest saved rules loaded.");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload: LaborAllocationRules = {
        ...draft,
        jobAliases: aliases.map(({ alias, sourceKey, workerName, date }) => ({
          alias: alias.trim(),
          sourceKey,
          ...(workerName && date ? { workerName, date } : {}),
        })),
      };
      const result = await readApi<{ rules: LaborAllocationRules; rulesRevision: number }>(
        await fetch("/api/manager/labor/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: payload, expectedRevision: baseRevision }),
        }),
      );
      setDraft(result.rules);
      setAliases(aliasDrafts(result.rules));
      setBaseRevision(result.rulesRevision);
      setNotice(
        "Reviewed location classifications and job aliases saved. Allocations were recalculated.",
      );
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save allocation rules.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <div className={styles.cardBody}>
        <p className={styles.muted}>
          Review each recorded location. Travel and intermediate shop or supplier stops follow the
          next identifiable customer job. Opening shop time and final returns are excluded when the
          complete day supports that decision. Explicitly excluded locations stay out of job
          allocations, and unknown locations stay pending. A customer classification establishes a
          source destination. Confirm its Housecall identity in Housecall job links; weekly pay
          estimates remain separate from job costs.
        </p>
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
        {revision !== baseRevision && (
          <div className={styles.error}>
            Saved rules changed while you were editing.{" "}
            <button className={styles.textButton} type="button" onClick={useLatest}>
              Use latest saved rules
            </button>
          </div>
        )}
      </div>
      {options.length === 0 ? (
        <div className={styles.empty}>Import hours to review source locations.</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Recorded location</th>
                <th>Reviewed classification</th>
                <th>Customer destination</th>
              </tr>
            </thead>
            <tbody>
              {options.map((source) => {
                const location = draft.locations.find(
                  (item) => item.sourceKey === source.sourceKey,
                );
                return (
                  <tr key={source.sourceKey}>
                    <td>
                      <strong>{source.name}</strong>
                      <small>{source.address || "Address not supplied"}</small>
                    </td>
                    <td>
                      <select
                        aria-label={`Classification for ${source.name}`}
                        className={styles.ruleSelect}
                        value={location?.kind ?? "unknown"}
                        onChange={(event) =>
                          classify(
                            source.sourceKey,
                            event.target.value as ReviewedLaborLocation["kind"],
                          )
                        }
                        disabled={busy}
                      >
                        <option value="unknown">Unknown / needs review</option>
                        <option value="shop">SVL / shop</option>
                        <option value="supplier">Supplier</option>
                        <option value="customer">Customer job</option>
                        <option value="excluded">Excluded location</option>
                      </select>
                    </td>
                    <td>
                      {location?.kind === "customer" ? (
                        <>
                          {location.job?.name}
                          <small>Source customer destination</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.cardBody}>
        <div className={styles.importHeading}>
          <div>
            <h3>Daily comment job aliases</h3>
            <p className={styles.muted}>
              Map the exact job phrase used in a comment to a reviewed customer location.
            </p>
          </div>
          <button
            className={styles.button}
            type="button"
            disabled={busy || customers.length === 0}
            onClick={() =>
              setAliases((current) => [
                ...current,
                { localId: `new-${nextAlias.current++}`, alias: "", sourceKey: "" },
              ])
            }
          >
            Add alias
          </button>
        </div>
        {aliases.length === 0 && (
          <p className={styles.muted}>
            No job aliases saved. Customer locations must be reviewed before an alias can be added.
          </p>
        )}
        {aliases.map((row) => (
          <div className={styles.aliasRow} key={row.localId}>
            <label>
              Comment job phrase
              <input
                required
                maxLength={180}
                value={row.alias}
                disabled={busy}
                onChange={(event) =>
                  setAliases((current) =>
                    current.map((item) =>
                      item.localId === row.localId ? { ...item, alias: event.target.value } : item,
                    ),
                  )
                }
              />
              {row.workerName && row.date && (
                <small>
                  Applies to {row.workerName} on {row.date}.
                </small>
              )}
            </label>
            <label>
              Reviewed customer job
              <select
                required
                value={row.sourceKey}
                disabled={busy}
                onChange={(event) =>
                  setAliases((current) =>
                    current.map((item) =>
                      item.localId === row.localId
                        ? { ...item, sourceKey: event.target.value }
                        : item,
                    ),
                  )
                }
              >
                <option value="">Select customer job</option>
                {customers.map((location) => (
                  <option key={location.sourceKey} value={location.sourceKey}>
                    {location.job?.name} · {location.job?.address}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={styles.textButton}
              type="button"
              disabled={busy}
              onClick={() =>
                setAliases((current) => current.filter((item) => item.localId !== row.localId))
              }
            >
              Remove alias
            </button>
          </div>
        ))}
        <div className={styles.actions}>
          <button
            className={styles.primary}
            type="submit"
            disabled={busy || revision !== baseRevision}
          >
            {busy ? "Saving rules…" : "Save reviewed rules"}
          </button>
          <span className={styles.muted}>Revision {baseRevision} · saved allocation rules</span>
        </div>
      </div>
    </form>
  );
}
