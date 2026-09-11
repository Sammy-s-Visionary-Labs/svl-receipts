import {
  HOUSECALL_ORIGIN,
  isHousecallQuantitySupported,
  validateHousecallId,
  verifyPreparedHousecallWrite,
} from "./payloads";
import type {
  HousecallAttachment,
  HousecallJob,
  HousecallJobsPage,
  HousecallJobsQuery,
  HousecallMaterial,
  HousecallReconciliation,
  HousecallWritePermit,
  HousecallWriteResult,
  PreparedHousecallWrite,
} from "./types";

export type HousecallErrorCode =
  | "configuration"
  | "write_blocked"
  | "invalid_payload"
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "invalid_response"
  | "network"
  | "timeout"
  | "unsafe_destination";
export class HousecallError extends Error {
  readonly name = "HousecallError";
  constructor(
    readonly code: HousecallErrorCode,
    readonly httpStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly writeOutcomeUnknown = false,
  ) {
    super(`Housecall request failed: ${code}`);
  }
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HousecallError("invalid_response");
  return value as JsonObject;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function requiredString(value: unknown): string {
  const result = nullableString(value);
  if (result === null) throw new HousecallError("invalid_response");
  return result;
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HousecallError("invalid_response");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HousecallError("invalid_response");
  return value;
}
function parseAttachment(value: unknown): HousecallAttachment {
  const row = object(value);
  return {
    id: requiredString(row.id),
    fileName: requiredString(row.file_name),
    fileType: nullableString(row.file_type),
    url: nullableString(row.url),
  };
}
export function parseHousecallJob(value: unknown): HousecallJob {
  const row = object(value);
  const customer = row.customer == null ? {} : object(row.customer);
  const address = row.address == null ? {} : object(row.address);
  const schedule = row.schedule == null ? {} : object(row.schedule);
  const workStatus = requiredString(row.work_status);
  const canceled = ["user canceled", "pro canceled"].includes(workStatus) || !!row.canceled_at;
  const deleted = !!row.deleted_at || workStatus === "pro canceled";
  return {
    id: requiredString(row.id),
    invoiceNumber: nullableString(row.invoice_number),
    description: nullableString(row.description) ?? "",
    customerId: nullableString(customer.id),
    customerName:
      [nullableString(customer.first_name), nullableString(customer.last_name)]
        .filter(Boolean)
        .join(" ") ||
      nullableString(customer.company) ||
      "",
    customerNotificationsEnabled:
      typeof customer.notifications_enabled === "boolean" ? customer.notifications_enabled : null,
    address:
      [address.street, address.street_line_2, address.city, address.state, address.zip]
        .map(nullableString)
        .filter(Boolean)
        .join(", ") || null,
    workStatus,
    active:
      !canceled &&
      !deleted &&
      ["needs scheduling", "scheduled", "in progress"].includes(workStatus),
    canceled,
    deleted,
    locked: !!row.locked_at,
    scheduledStart: nullableString(schedule.scheduled_start),
    scheduledEnd: nullableString(schedule.scheduled_end),
    assignedEmployeeIds:
      row.assigned_employees == null
        ? []
        : array(row.assigned_employees).map((employee) => requiredString(object(employee).id)),
    updatedAt: nullableString(row.updated_at),
    attachments: row.attachments == null ? null : array(row.attachments).map(parseAttachment),
  };
}
function parseMaterial(value: unknown): HousecallMaterial {
  const row = object(value);
  // Read models must tolerate unrelated placeholders and optional provider fields.
  // Our own reference still requires a complete, exact match in reconcileWrite.
  return {
    id: nullableString(row.uuid)?.trim() || null,
    name: nullableString(row.name) ?? "",
    description: nullableString(row.description) ?? "",
    partNumber: nullableString(row.part_number) ?? "",
    quantity:
      typeof row.quantity === "number" && Number.isFinite(row.quantity) ? row.quantity : null,
    unitCostCents:
      typeof row.unit_cost === "number" && Number.isSafeInteger(row.unit_cost)
        ? row.unit_cost
        : null,
  };
}

export function parseHousecallRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(0, parsed - nowMs), 86_400_000) : null;
}
/** Housecall documents RateLimit-Reset as the Unix epoch time of quota reset. */
export function parseHousecallRateLimitReset(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1000) return null;
  return Math.min(Math.max(0, seconds * 1000 - nowMs), 86_400_000);
}
export type HousecallClientOptions = {
  apiKey: string;
  /** Test-only transport injection; production callers use native server fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Empty by default. Exact provider IDs only; a customer/job name is never authorization. */
  allowedWriteJobIds?: readonly string[];
  allowedReadJobIds?: readonly string[];
  allowedReadCustomerIds?: readonly string[];
  /** Opaque receipt or synchronization reference; never a customer name or credential. */
  correlationId?: string;
  now?: () => number;
};
export function createHousecallClient(options: HousecallClientOptions) {
  if (
    typeof window !== "undefined" ||
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim() ||
    /[\r\n]/.test(options.apiKey)
  )
    throw new HousecallError("configuration");
  const apiKey = options.apiKey.trim();
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    typeof transport !== "function"
  )
    throw new HousecallError("configuration");
  const allowlist = new Set((options.allowedWriteJobIds ?? []).map(validateHousecallId));
  const readJobs = options.allowedReadJobIds
    ? new Set(options.allowedReadJobIds.map(validateHousecallId))
    : null;
  const readCustomers = options.allowedReadCustomerIds
    ? new Set(options.allowedReadCustomerIds.map(validateHousecallId))
    : null;
  const now = options.now ?? Date.now;
  const consumedPermits = new Set<string>();
  const correlationId = options.correlationId ?? `sync-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(correlationId)) throw new HousecallError("configuration");
  let requestSequence = 0;
  let authorizationFailure: HousecallError | null = null;

  async function request(
    path: string,
    init: { method?: "GET" | "PUT" | "POST"; body?: BodyInit; json?: boolean } = {},
  ): Promise<{ data: unknown; status: number }> {
    if (authorizationFailure) throw authorizationFailure;
    const requestId = `${correlationId}-${++requestSequence}`;
    const method = init.method ?? "GET";
    const isWrite = method !== "GET";
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      const response = await transport(`${HOUSECALL_ORIGIN}${path}`, {
        method,
        body: init.body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: abort.signal,
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
          "X-Request-Id": requestId,
          ...(init.json ? { "Content-Type": "application/json" } : {}),
        },
      });
      // A test transport can return a redirected response despite redirect:error. Fail closed.
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== HOUSECALL_ORIGIN)
      )
        throw new HousecallError("invalid_response", response.status, null, isWrite);
      if (!response.ok) {
        const retryAfter = parseHousecallRetryAfter(response.headers.get("retry-after"), now());
        const resetAfter = parseHousecallRateLimitReset(
          response.headers.get("ratelimit-reset"),
          now(),
        );
        const retryAfterMs =
          retryAfter === null && resetAfter === null
            ? null
            : Math.max(retryAfter ?? 0, resetAfter ?? 0);
        const code: HousecallErrorCode =
          response.status === 401
            ? "authentication"
            : response.status === 403
              ? "forbidden"
              : response.status === 404
                ? "not_found"
                : response.status === 429
                  ? "rate_limited"
                  : response.status >= 500
                    ? "provider_unavailable"
                    : "provider_rejected";
        // Do not retain provider response bodies; they can contain credentials or private receipt data.
        throw new HousecallError(
          code,
          response.status,
          retryAfterMs,
          isWrite &&
            (response.status >= 500 ||
              response.status === 408 ||
              (response.status >= 300 && response.status < 400)),
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new HousecallError("invalid_response", response.status, null, isWrite);
      }
      return { data, status: response.status };
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new HousecallError("timeout", null, null, isWrite));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof HousecallError) {
        if (error.code === "authentication" || error.code === "forbidden")
          authorizationFailure = error;
        throw error;
      }
      throw new HousecallError(abort.signal.aborted ? "timeout" : "network", null, null, isWrite);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function getJob(
    jobId: string,
    options: { includeAttachments?: boolean } = {},
  ): Promise<HousecallJob> {
    validateHousecallId(jobId);
    if (readJobs && !readJobs.has(jobId)) throw new HousecallError("unsafe_destination");
    const suffix = options.includeAttachments ? "?expand%5B%5D=attachments" : "";
    const { data } = await request(`/jobs/${jobId}${suffix}`);
    const result = parseHousecallJob(data);
    if (result.id !== jobId || (options.includeAttachments && result.attachments === null))
      throw new HousecallError("invalid_response");
    if (readCustomers && (!result.customerId || !readCustomers.has(result.customerId)))
      throw new HousecallError("unsafe_destination");
    return result;
  }
  async function listJobs(query: HousecallJobsQuery = {}): Promise<HousecallJobsPage> {
    if (readCustomers && (!query.customerId || !readCustomers.has(query.customerId)))
      throw new HousecallError("unsafe_destination");
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new HousecallError("invalid_payload");
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (query.customerId) params.set("customer_id", validateHousecallId(query.customerId));
    if (query.scheduledStartMin) params.set("scheduled_start_min", query.scheduledStartMin);
    if (query.scheduledStartMax) params.set("scheduled_start_max", query.scheduledStartMax);
    // The live provider requires bracketed array keys, including for one value.
    for (const status of query.workStatus ?? []) {
      if (!["unscheduled", "scheduled", "in_progress", "completed", "canceled"].includes(status))
        throw new HousecallError("invalid_payload");
      params.append("work_status[]", status);
    }
    if (query.sortBy) params.set("sort_by", query.sortBy);
    if (query.sortDirection) params.set("sort_direction", query.sortDirection);
    const { data } = await request(`/jobs?${params}`);
    const row = object(data);
    const result = {
      jobs: array(row.jobs).map(parseHousecallJob),
      page: nonnegativeInteger(row.page),
      pageSize: nonnegativeInteger(row.page_size),
      totalPages: nonnegativeInteger(row.total_pages),
      totalItems: nonnegativeInteger(row.total_items),
    };
    if (
      result.page !== page ||
      result.pageSize < 1 ||
      result.jobs.length > result.pageSize ||
      (result.totalPages === 0 && result.jobs.length > 0)
    )
      throw new HousecallError("invalid_response");
    if (
      readCustomers &&
      result.jobs.some(
        (job) =>
          !job.customerId ||
          job.customerId !== query.customerId ||
          !readCustomers.has(job.customerId),
      )
    )
      throw new HousecallError("unsafe_destination");
    return result;
  }
  async function listAllJobs(
    query: Omit<HousecallJobsQuery, "page"> = {},
    bounds: { maxPages?: number } = {},
  ): Promise<HousecallJob[]> {
    const maxPages = bounds.maxPages ?? 100;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
      throw new HousecallError("invalid_payload");
    const jobs = new Map<string, HousecallJob>();
    for (let page = 1; page <= maxPages; page++) {
      const result = await listJobs({ ...query, page });
      for (const job of result.jobs) jobs.set(job.id, job);
      if (page >= result.totalPages) return [...jobs.values()];
    }
    // Do not mistake a bounded partial scan for complete job synchronization.
    throw new HousecallError("invalid_response");
  }
  async function listJobInputMaterials(jobId: string): Promise<HousecallMaterial[]> {
    if (readJobs && !readJobs.has(jobId)) throw new HousecallError("unsafe_destination");
    const { data } = await request(`/jobs/${validateHousecallId(jobId)}/job_input_materials`);
    return array(object(data).job_input_materials).map(parseMaterial);
  }
  async function inspectJobAttachments(jobId: string): Promise<HousecallAttachment[]> {
    return (await getJob(jobId, { includeAttachments: true })).attachments ?? [];
  }
  async function reconcileWrite(write: PreparedHousecallWrite): Promise<HousecallReconciliation> {
    if (!(await verifyPreparedHousecallWrite(write))) throw new HousecallError("invalid_payload");
    if (write.kind === "attachment") {
      const matches = (await inspectJobAttachments(write.jobId)).filter(
        (attachment) => attachment.fileName === write.fileName,
      );
      if (matches.length > 1) return { status: "conflict", reason: "duplicate_reference" };
      return matches[0] ? { status: "found", providerId: matches[0].id } : { status: "absent" };
    }
    const matches = (await listJobInputMaterials(write.jobId)).filter(
      (material) => material.partNumber === write.reference,
    );
    if (matches.length > 1) return { status: "conflict", reason: "duplicate_reference" };
    const match = matches[0];
    if (!match) return { status: "absent" };
    const expected = write.body.job_input_materials[0];
    if (
      !expected ||
      !match.id ||
      match.name !== expected.name ||
      match.description !== expected.description ||
      match.quantity !== expected.quantity ||
      match.unitCostCents !== expected.unit_cost
    )
      return { status: "conflict", reason: "payload_mismatch" };
    return { status: "found", providerId: match.id };
  }
  async function executePreparedWrite(
    write: PreparedHousecallWrite,
    permit?: HousecallWritePermit,
  ): Promise<HousecallWriteResult> {
    if (!allowlist.has(write.jobId) || !permit) throw new HousecallError("write_blocked");
    // Snapshot first: mutation by a concurrent caller cannot change the payload after validation.
    const frozen = structuredClone(write);
    const grant = { ...permit };
    const approvedAt = Date.parse(grant.approvedAt);
    const expiresAt = Date.parse(grant.expiresAt);
    const permitKey = `${grant.approvalId}:${grant.requestHash}`;
    if (
      !grant.approvalId?.trim() ||
      !grant.approvedBy?.trim() ||
      !Number.isFinite(approvedAt) ||
      !Number.isFinite(expiresAt) ||
      approvedAt > now() ||
      expiresAt <= now() ||
      expiresAt <= approvedAt ||
      expiresAt - approvedAt > 86_400_000 ||
      grant.jobId !== frozen.jobId ||
      grant.requestHash !== frozen.requestHash ||
      consumedPermits.has(permitKey)
    )
      throw new HousecallError("write_blocked");
    if (!(await verifyPreparedHousecallWrite(frozen))) throw new HousecallError("invalid_payload");
    if (
      frozen.kind === "job_cost" &&
      !isHousecallQuantitySupported(frozen.body.job_input_materials[0]?.quantity)
    )
      throw new HousecallError("invalid_payload");
    // Reserve before an await so concurrent callers cannot dispatch the same grant twice.
    if (consumedPermits.has(permitKey)) throw new HousecallError("write_blocked");
    consumedPermits.add(permitKey);
    const job = await getJob(frozen.jobId);
    if (
      (grant.expectedCustomerId !== undefined && job.customerId !== grant.expectedCustomerId) ||
      job.deleted ||
      job.canceled ||
      job.locked ||
      ![
        "needs scheduling",
        "scheduled",
        "in progress",
        "complete rated",
        "complete unrated",
      ].includes(job.workStatus)
    )
      throw new HousecallError("unsafe_destination");
    if (expiresAt <= now()) throw new HousecallError("write_blocked");
    let result: { data: unknown; status: number };
    if (frozen.kind === "attachment") {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(frozen.bytes)], { type: frozen.contentType }),
        frozen.fileName,
      );
      result = await request(frozen.path, { method: frozen.method, body: form });
      // The approved live attachment test returned 201 rather than documented 202.
      // Both responses still require exact filename reconciliation on the job.
      if (result.status !== 201 && result.status !== 202)
        throw new HousecallError("invalid_response", result.status, null, true);
    } else {
      result = await request(frozen.path, {
        method: frozen.method,
        body: JSON.stringify(frozen.body),
        json: true,
      });
      if (result.status !== 200)
        throw new HousecallError("invalid_response", result.status, null, true);
    }
    // An accepted response is not verification. The worker must reconcile on the exact target job.
    return { status: "accepted", httpStatus: result.status };
  }
  async function checkHealth(): Promise<{ connected: true; writesEnabled: false }> {
    await listJobs({
      page: 1,
      pageSize: 1,
      ...(readCustomers ? { customerId: [...readCustomers][0] } : {}),
    });
    // Individual explicit permits are required even with a configured allowlist.
    return { connected: true, writesEnabled: false };
  }
  return {
    getJob,
    listJobs,
    listAllJobs,
    listJobInputMaterials,
    inspectJobAttachments,
    reconcileWrite,
    executePreparedWrite,
    checkHealth,
  };
}
export type HousecallClient = ReturnType<typeof createHousecallClient>;
