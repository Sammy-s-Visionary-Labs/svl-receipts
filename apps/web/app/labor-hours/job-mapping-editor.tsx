"use client";

import {
  type LaborJobMapping,
  type LaborJobMappingSuggestion,
  type LaborMappingCatalogJob,
  type LaborMappingSource,
  laborCatalogJobIsStale,
} from "@svl/domain";
import { type FormEvent, useState } from "react";
import type { LaborDashboardData } from "@/lib/labor/contract";
import styles from "./labor.module.css";
import { readApi, shortDate } from "./labor-view";

const evidence: Record<LaborJobMappingSuggestion["candidates"][number]["reasons"][number], string> =
  {
    exact_address: "Exact full address",
    exact_customer: "Exact full customer name",
    exact_job_number: "Exact source job number",
    property_address: "Same street property; full address needs review",
    customer_name_token: "Customer name tokens; identity needs review",
    job_label_tokens: "Project label tokens; identity needs review",
  };
const mappingIdentity = (mapping: LaborJobMapping) =>
  JSON.stringify([mapping.sourceKey, mapping.fromDate, mapping.toDate]);

export function LaborJobMappingEditor({
  data,
  onChanged,
}: {
  data: LaborDashboardData;
  onChanged: () => Promise<void>;
}) {
  const [saved, setSaved] = useState<readonly LaborJobMapping[]>(data.jobMappings);
  const [baseRevision, setBaseRevision] = useState(data.jobMappingsRevision);
  const [reviewGeneration, setReviewGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stale = baseRevision !== data.jobMappingsRevision;
  const customers = data.mappingSources.filter((source) => source.classification === "customer");
  const unknowns = data.mappingSources.filter((source) => source.classification === "unknown");
  const exact = data.jobMappingSuggestions.filter(
    (suggestion) =>
      suggestion.automaticJobId &&
      !saved.some((mapping) => mapping.sourceKey === suggestion.sourceKey),
  );

  async function save(mappings: readonly LaborJobMapping[]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await readApi<{ mappings: LaborJobMapping[]; jobMappingsRevision: number }>(
        await fetch("/api/manager/labor/mappings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mappings,
            expectedRevision: baseRevision,
            catalogFingerprint: data.jobCatalog.fingerprint,
          }),
        }),
      );
      setSaved(result.mappings);
      setBaseRevision(result.jobMappingsRevision);
      setNotice("Job links saved for the confirmed dates. Later imports require their own review.");
      await onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save job links.";
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(mapping: LaborJobMapping, previous: string | null) {
    await save([...saved.filter((value) => previous !== mappingIdentity(value)), mapping]);
  }

  async function matchExact() {
    const mappings = exact.flatMap((suggestion): LaborJobMapping[] => {
      const source = customers.find((value) => value.sourceKey === suggestion.sourceKey);
      return source && suggestion.automaticJobId
        ? [
            {
              sourceKey: source.sourceKey,
              housecallJobId: suggestion.automaticJobId,
              fromDate: source.fromDate,
              toDate: source.toDate,
              confirmedAt: "",
              confirmedBy: "",
              method: "exact_customer_address",
            },
          ]
        : [];
    });
    await save([...saved, ...mappings]);
  }

  return (
    <section className={styles.card} aria-labelledby="labor-job-mapping-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="labor-job-mapping-title">Housecall job links</h2>
          <p>
            {customers.length} imported customer locations · {saved.length} confirmed date ranges
          </p>
        </div>
        <span className={styles.badge}>Manager review</span>
      </div>
      <div className={styles.cardBody}>
        <p className={styles.muted}>
          Choose the specific Housecall job for each imported customer location. Customer names and
          street addresses can suggest candidates; only one exact full customer and full address
          match can be matched automatically. Confirmed links join allocated labor and receipts by
          Housecall job ID, for these work dates only. These links stay inside the receipt app. No
          labor hours or labor costs are sent to Housecall; sending labor later requires separate
          approval.
        </p>
        <p className={styles.muted}>
          Catalog:{" "}
          {data.jobCatalog.complete
            ? `${data.jobCatalog.jobs.length} jobs, including historical jobs`
            : "Incomplete or unavailable; new links are blocked"}
          . Last successful sync:{" "}
          {data.jobCatalog.lastSuccessfulSyncAt
            ? new Date(data.jobCatalog.lastSuccessfulSyncAt).toLocaleString()
            : "Unavailable"}
          .
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
        {stale && (
          <p role="status" className={styles.notice}>
            Job links changed while this review was open.{" "}
            <button
              type="button"
              className={styles.textButton}
              disabled={busy}
              onClick={() => {
                setSaved(data.jobMappings);
                setBaseRevision(data.jobMappingsRevision);
                setReviewGeneration((value) => value + 1);
                setError("");
                setNotice("");
              }}
            >
              Reload saved links
            </button>
          </p>
        )}
        {exact.length > 0 && (
          <button
            type="button"
            className={styles.primary}
            disabled={busy || stale || !data.jobCatalog.complete}
            onClick={() => void matchExact().catch(() => {})}
          >
            Match {exact.length} exact customer and address {exact.length === 1 ? "job" : "jobs"}
          </button>
        )}
        {customers.length === 0 && (
          <p className={styles.empty}>No reviewed customer locations in the imported hours yet.</p>
        )}
        {customers.map((source) => (
          <SourceJobReview
            key={`${reviewGeneration}:${source.sourceKey}`}
            source={source}
            suggestion={data.jobMappingSuggestions.find(
              (value) => value.sourceKey === source.sourceKey,
            )}
            jobs={data.jobCatalog.jobs}
            mappings={saved.filter((mapping) => mapping.sourceKey === source.sourceKey)}
            disabled={busy || stale}
            canConfirm={data.jobCatalog.complete && !!data.jobCatalog.fingerprint}
            onConfirm={confirm}
            onRemove={(mapping) =>
              save(saved.filter((value) => mappingIdentity(value) !== mappingIdentity(mapping)))
            }
          />
        ))}
        {unknowns.length > 0 && (
          <details>
            <summary>
              {unknowns.length} source locations need classification before Housecall linking
            </summary>
            <ul>
              {unknowns.map((source) => (
                <li key={source.sourceKey}>
                  {source.name} · {source.address || "Address not supplied"}
                </li>
              ))}
            </ul>
            <p className={styles.muted}>
              Review these in allocation rules. Supplier, shop and excluded locations do not become
              customer jobs.
            </p>
          </details>
        )}
      </div>
    </section>
  );
}

function SourceJobReview({
  source,
  suggestion,
  jobs,
  mappings,
  disabled,
  canConfirm,
  onConfirm,
  onRemove,
}: {
  source: LaborMappingSource;
  suggestion: LaborJobMappingSuggestion | undefined;
  jobs: readonly LaborMappingCatalogJob[];
  mappings: readonly LaborJobMapping[];
  disabled: boolean;
  canConfirm: boolean;
  onConfirm: (mapping: LaborJobMapping, previous: string | null) => Promise<void>;
  onRemove: (mapping: LaborJobMapping) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [from, setFrom] = useState(source.fromDate);
  const [to, setTo] = useState(source.toDate);
  const [search, setSearch] = useState("");
  const [previous, setPrevious] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const selected = jobs.find((job) => job.id === selectedId);
  const selectedEligible =
    !!selected &&
    !selected.unavailable &&
    !!selected.customerId &&
    !laborCatalogJobIsStale(selected);
  const query = search.trim().toLocaleLowerCase();
  const suggestedIds = new Set(suggestion?.candidates.map((candidate) => candidate.job.id) ?? []);
  const results = query
    ? jobs.filter((job) =>
        [job.id, job.number ?? "", job.customer ?? "", job.label, job.address ?? ""].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
      )
    : jobs.filter((job) => suggestedIds.has(job.id));
  const options = results.slice(0, 100);
  if (selected && !options.some((job) => job.id === selected.id)) options.unshift(selected);
  const detailsId = `job-review-${encodeURIComponent(source.sourceKey)}`;
  function select(value: string) {
    setSelectedId(value);
    setConfirmed(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !selectedEligible || !confirmed) return;
    try {
      await onConfirm(
        {
          sourceKey: source.sourceKey,
          housecallJobId: selected.id,
          fromDate: from,
          toDate: to,
          confirmedAt: "",
          confirmedBy: "",
          method: "reviewed",
        },
        previous,
      );
      setPrevious(null);
      setSelectedId("");
      setConfirmed(false);
    } catch {
      /* The parent exposes the API error. */
    }
  }
  return (
    <details className={styles.cardBody}>
      <summary>
        <strong>{source.name}</strong> ·{" "}
        {mappings.length
          ? `${mappings.length} confirmed range${mappings.length === 1 ? "" : "s"}`
          : "Awaiting job confirmation"}
      </summary>
      <p>
        Source address: <strong>{source.address || "Not supplied"}</strong>
        <br />
        Imported work dates: {shortDate(source.fromDate)} – {shortDate(source.toDate)}
        {source.jobCodes.length > 0 && (
          <>
            <br />
            Source job numbers: {source.jobCodes.join(", ")}
          </>
        )}
      </p>
      {suggestion?.reviewReasons.map((reason) => (
        <p className={styles.muted} key={reason}>
          {reason}
        </p>
      ))}
      {mappings.map((mapping) => {
        const job = jobs.find((value) => value.id === mapping.housecallJobId);
        return (
          <div key={mappingIdentity(mapping)} className={styles.notice}>
            <strong>{job?.label || mapping.housecallJobId}</strong> · {shortDate(mapping.fromDate)}{" "}
            – {shortDate(mapping.toDate)}
            <br />
            {job?.address || "Catalog address unavailable"}
            <br />
            <small>
              {mapping.method === "reviewed"
                ? "Manager confirmed"
                : "Exact customer and full address"}{" "}
              · {mapping.confirmedBy} · {mapping.confirmedAt}
            </small>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={disabled}
                onClick={() => {
                  setPrevious(mappingIdentity(mapping));
                  select(mapping.housecallJobId);
                  setFrom(mapping.fromDate);
                  setTo(mapping.toDate);
                }}
              >
                Change link
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={disabled}
                onClick={() => void onRemove(mapping).catch(() => {})}
              >
                Remove link
              </button>
            </div>
          </div>
        );
      })}
      {suggestion && suggestion.candidates.length > 0 && (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption>Suggested jobs for review; these are not confirmed links</caption>
            <thead>
              <tr>
                <th>Housecall job</th>
                <th>Customer / full address</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {suggestion.candidates.map((candidate) => (
                <tr key={candidate.job.id}>
                  <td>
                    {candidate.job.label}
                    <small>
                      #{candidate.job.number || "Unspecified"} ·{" "}
                      {candidate.job.status || "Unknown status"}
                    </small>
                    <small>{candidate.job.id}</small>
                    {!candidate.eligible && (
                      <small>Unavailable or stale; cannot confirm a new link</small>
                    )}
                  </td>
                  <td>
                    {candidate.job.customer || "Customer unavailable"}
                    <small>{candidate.job.address || "Address not supplied"}</small>
                  </td>
                  <td>
                    {candidate.reasons.map((reason) => (
                      <small key={reason}>{evidence[reason]}</small>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={disabled || !canConfirm} className={styles.filters}>
          <label>
            Search complete Housecall catalog
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Customer, job number, address or ID"
            />
          </label>
          <label>
            Specific Housecall job
            <select required value={selectedId} onChange={(event) => select(event.target.value)}>
              <option value="">Select a job after reviewing its details</option>
              {options.map((job) => (
                <option
                  key={job.id}
                  value={job.id}
                  disabled={job.unavailable || !job.customerId || laborCatalogJobIsStale(job)}
                >
                  #{job.number || "—"} · {job.customer || job.label} · {job.address || "No address"}{" "}
                  · {job.status || "Unknown status"}
                </option>
              ))}
            </select>
          </label>
          <label>
            First work date
            <input
              type="date"
              required
              min={source.fromDate}
              max={source.toDate}
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            Last work date
            <input
              type="date"
              required
              min={from || source.fromDate}
              max={source.toDate}
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
        </fieldset>
        {results.length > 100 && (
          <p className={styles.muted}>
            Showing the first 100 of {results.length} results. Refine the search to find the
            specific job.
          </p>
        )}
        {selected && (
          <div id={detailsId} className={styles.notice}>
            <strong>{selected.label}</strong>
            <br />
            Housecall customer: {selected.customer || "Unavailable"}
            <br />
            Housecall address: {selected.address || "Not supplied"}
            <br />
            Job #{selected.number || "Unspecified"} · {selected.status || "Unknown status"}
            <br />
            Housecall ID: {selected.id}
            <br />
            Compare with source: {source.name} · {source.address || "Address not supplied"}
          </div>
        )}
        {selected && !selectedEligible && (
          <p role="status" className={styles.notice}>
            This job is unavailable, stale or missing customer identity. Refresh its details before
            confirming a new link.
          </p>
        )}
        <label>
          <input
            type="checkbox"
            disabled={disabled || !canConfirm || !selectedEligible}
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            aria-describedby={selected ? detailsId : undefined}
          />{" "}
          I reviewed the customer, address, specific job and date range, including any differences.
        </label>
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primary}
            disabled={disabled || !canConfirm || !selectedEligible || !confirmed}
          >
            Confirm {previous ? "updated " : ""}job link for these dates
          </button>
          {previous && (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setPrevious(null);
                select("");
                setFrom(source.fromDate);
                setTo(source.toDate);
              }}
            >
              Cancel change
            </button>
          )}
        </div>
      </form>
    </details>
  );
}
