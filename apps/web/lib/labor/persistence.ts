import { createHash, randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";

export const LABOR_ORIGINALS_BUCKET = "labor-originals";
export const LABOR_WORKER_SESSIONS_BUCKET = "labor-worker-sessions";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_BYTES = 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;
export type LaborPersistenceLeaseGuard = {
  leaseToken: string;
  commandId: string;
  period: { from: string; to: string };
};
type SourceManifest = {
  id: string;
  kind: "timesheet" | "notes";
  position: number;
  content_hash: string;
};
type SourceRecord = SourceManifest & {
  file_sha256: string;
  summary: JsonObject;
  report: JsonObject | null;
};
type Snapshot = { state: JsonObject; revision: number; manifest: SourceManifest[] };
// This cache only avoids retransmitting reports. The database revision is checked on every read.
// It is never an authorization cache; routes must check the active actor before invoking this DAL.
let cached: { target: string; snapshot: Snapshot } | null = null;

function target() {
  if (typeof window !== "undefined") throw new Error("Labor persistence is server-only");
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(value: unknown): SourceManifest[] {
  if (!Array.isArray(value)) throw new Error("Invalid labor persistence response");
  return value.map((row) => {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !uuid.test(row.id) ||
      !["timesheet", "notes"].includes(String(row.kind)) ||
      !revision(row.position) ||
      typeof row.content_hash !== "string" ||
      !sha256.test(row.content_hash)
    )
      throw new Error("Invalid labor persistence response");
    return row as SourceManifest;
  });
}

function splitState(input: JsonObject) {
  // Match JSON wire semantics before computing hashes: omitted fields must hash identically on reload.
  const state = JSON.parse(JSON.stringify(input)) as JsonObject;
  const { imports, notesImports, ...control } = state;
  if (!Array.isArray(imports) || !Array.isArray(notesImports))
    throw new Error("Invalid labor source lists");
  const records: SourceRecord[] = [];
  const seen = new Set<string>();
  for (const [kind, rows] of [
    ["timesheet", imports],
    ["notes", notesImports],
  ] as const) {
    rows.forEach((row: unknown, position) => {
      if (
        !object(row) ||
        typeof row.id !== "string" ||
        !uuid.test(row.id) ||
        typeof row.hash !== "string" ||
        !sha256.test(row.hash) ||
        seen.has(row.id) ||
        (row.report !== undefined && row.report !== null && !object(row.report))
      )
        throw new Error("Invalid labor source record");
      seen.add(row.id);
      const { id, hash, report, ...summary } = row;
      // SQL omits a pruned report rather than returning report:null; keep hash semantics identical.
      const retained = { id, hash, ...summary, ...(object(report) ? { report } : {}) };
      rows[position] = retained;
      records.push({
        id,
        kind,
        position,
        file_sha256: hash,
        summary,
        report: object(report) ? report : null,
        content_hash: digest(canonical(retained)),
      });
    });
  }
  return { state, control, records };
}

/** Consistent shared snapshot, or null before the first successful CAS initialization. */
export async function readSupabaseLaborState(): Promise<{
  state: JsonObject;
  revision: number;
} | null> {
  const key = target();
  const previous = cached?.target === key ? cached.snapshot : null;
  const { data, error } = await createServiceRoleClient().rpc("read_labor_state", {
    p_known_revision: previous?.revision ?? null,
  });
  if (error) throw new Error("Labor state could not be loaded");
  if (data === null) {
    cached = null;
    return null;
  }
  if (!object(data) || !revision(data.revision))
    throw new Error("Invalid labor persistence response");
  if (data.unchanged === true) {
    if (!previous || previous.revision !== data.revision)
      throw new Error("Invalid labor persistence response");
    return { state: structuredClone(previous.state), revision: previous.revision };
  }
  if (
    !object(data.state) ||
    !Array.isArray(data.state.imports) ||
    !Array.isArray(data.state.notesImports)
  )
    throw new Error("Invalid labor persistence response");
  const snapshot: Snapshot = {
    state: data.state,
    revision: data.revision,
    manifest: manifest(data.manifest),
  };
  cached = { target: key, snapshot };
  return { state: structuredClone(snapshot.state), revision: snapshot.revision };
}

/** A stale revision returns null and changes neither control nor any parsed source record. */
export async function compareAndSwapSupabaseLaborState(
  state: JsonObject,
  expectedRevision: number,
  actorId: string | null,
  leaseGuard?: LaborPersistenceLeaseGuard,
): Promise<number | null> {
  const key = target();
  if (!revision(expectedRevision) || (actorId !== null && !uuid.test(actorId)))
    throw new Error("Invalid labor update revision or actor");
  if (leaseGuard) {
    const date = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
    if (
      actorId !== null ||
      !uuid.test(leaseGuard.leaseToken) ||
      !uuid.test(leaseGuard.commandId) ||
      !date(leaseGuard.period.from) ||
      !date(leaseGuard.period.to) ||
      leaseGuard.period.from > leaseGuard.period.to
    )
      throw new Error("Invalid labor import lease guard");
  }
  const split = splitState(state);
  const client = createServiceRoleClient();
  let previous =
    cached?.target === key && cached.snapshot.revision === expectedRevision
      ? cached.snapshot.manifest
      : null;
  if (!previous) {
    const result = await client.rpc("read_labor_state_manifest");
    if (result.error) throw new Error("Labor update could not be prepared");
    if (!object(result.data) || !revision(result.data.revision))
      throw new Error("Invalid labor persistence response");
    if (result.data.revision !== expectedRevision) return null;
    previous = manifest(result.data.manifest);
  }
  const previousHashes = new Map(previous.map((row) => [row.id, row.content_hash]));
  const nextManifest = split.records.map(({ id, kind, position, content_hash }) => ({
    id,
    kind,
    position,
    content_hash,
  }));
  const changed = split.records.filter((row) => previousHashes.get(row.id) !== row.content_hash);
  const payload = {
    p_expected_revision: expectedRevision,
    p_control: split.control,
    p_manifest: nextManifest,
    p_changed_imports: changed,
  };
  const { data, error } = leaseGuard
    ? await client.rpc("compare_and_swap_labor_state_leased", {
        ...payload,
        p_lease_token: leaseGuard.leaseToken,
        p_command_id: leaseGuard.commandId,
        p_period_start: leaseGuard.period.from,
        p_period_end: leaseGuard.period.to,
      })
    : await client.rpc("compare_and_swap_labor_state", { ...payload, p_actor_id: actorId });
  if (error) {
    cached = null;
    throw new Error("Labor update could not be saved");
  }
  if (data === null) {
    cached = null;
    return null;
  }
  if (!revision(data) || data !== expectedRevision + 1)
    throw new Error("Invalid labor persistence response");
  cached = {
    target: key,
    snapshot: { state: split.state, revision: data, manifest: nextManifest },
  };
  return data;
}

function originalKey(id: string) {
  if (!uuid.test(id)) throw new Error("Invalid labor original identifier");
  return `${id}.xlsx`;
}

function missing(error: unknown) {
  return object(error) && (error.code === "NoSuchKey" || error.statusCode === "404");
}

async function workerSessionPointer(client: ReturnType<typeof createServiceRoleClient>) {
  const result = await client
    .from("labor_worker_sessions")
    .select("version,object_key,content_sha256")
    .eq("singleton", true)
    .maybeSingle();
  if (result.error) throw new Error("Encrypted worker session could not be loaded");
  const row = result.data;
  if (!row || row.object_key === null) return null;
  if (
    !revision(row.version) ||
    typeof row.object_key !== "string" ||
    !row.object_key.endsWith(".bin") ||
    !uuid.test(row.object_key.slice(0, -4)) ||
    typeof row.content_sha256 !== "string" ||
    !sha256.test(row.content_sha256)
  )
    throw new Error("Invalid worker session persistence response");
  return { version: row.version, key: row.object_key, hash: row.content_sha256 };
}

async function discardWorkerSessionObject(
  client: ReturnType<typeof createServiceRoleClient>,
  key: string,
) {
  // Cleanup failure retains an encrypted object; it must not undo a confirmed pointer update.
  try {
    await client.storage.from(LABOR_WORKER_SESSIONS_BUCKET).remove([key]);
  } catch {
    /* A transient storage error can leave this object for later maintenance. */
  }
}

/** Source XLSX objects are immutable. An exact upload retry succeeds without replacing bytes. */
export async function putSupabaseLaborOriginal(id: string, bytes: Uint8Array): Promise<void> {
  target();
  const key = originalKey(id);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ORIGINAL_BYTES)
    throw new Error("Labor original exceeds the file size limit");
  const bucket = createServiceRoleClient().storage.from(LABOR_ORIGINALS_BUCKET);
  const { error } = await bucket.upload(key, bytes, {
    contentType: XLSX_MIME,
    cacheControl: "0",
    upsert: false,
  });
  if (!error) return;
  if ((object(error) && error.code === "ResourceAlreadyExists") || error.statusCode === "409") {
    const existing = await bucket.download(key);
    if (!existing.error && existing.data) {
      const retained = new Uint8Array(await existing.data.arrayBuffer());
      if (digest(retained) === digest(bytes)) return;
      throw new Error("Labor original already exists with different contents");
    }
  }
  throw new Error("Labor original could not be stored");
}

export async function getSupabaseLaborOriginal(id: string): Promise<Uint8Array | null> {
  target();
  const { data, error } = await createServiceRoleClient()
    .storage.from(LABOR_ORIGINALS_BUCKET)
    .download(originalKey(id));
  if (error) {
    if (missing(error)) return null;
    throw new Error("Labor original could not be loaded");
  }
  if (!data || data.size > MAX_ORIGINAL_BYTES) throw new Error("Invalid labor original");
  return new Uint8Array(await data.arrayBuffer());
}

/** Short-lived private download avoids the host's response-size limit for preserved workbooks. */
export async function createSupabaseLaborOriginalDownloadUrl(
  id: string,
  filename: string,
): Promise<string> {
  target();
  const { data, error } = await createServiceRoleClient()
    .storage.from(LABOR_ORIGINALS_BUCKET)
    .createSignedUrl(originalKey(id), 60, { download: filename });
  if (error || !data?.signedUrl) throw new Error("Labor original could not be loaded");
  return data.signedUrl;
}

/** The caller encrypts the session before upload; plaintext credentials never enter this adapter. */
export async function putSupabaseLaborEncryptedWorkerSession(
  bytes: Uint8Array,
  expectedVersion = 0,
  leaseToken: string | null = null,
): Promise<number | null> {
  target();
  if (!revision(expectedVersion) || bytes.byteLength === 0 || bytes.byteLength > MAX_SESSION_BYTES)
    throw new Error("Invalid encrypted worker session");
  const client = createServiceRoleClient();
  const previous = await workerSessionPointer(client);
  const key = `${randomUUID()}.bin`;
  const upload = await client.storage.from(LABOR_WORKER_SESSIONS_BUCKET).upload(key, bytes, {
    contentType: "application/octet-stream",
    cacheControl: "0",
    upsert: false,
  });
  if (upload.error) throw new Error("Encrypted worker session could not be stored");
  const { data, error } = await client.rpc("compare_and_swap_labor_worker_session", {
    p_expected_version: expectedVersion,
    p_object_key: key,
    p_content_sha256: digest(bytes),
    p_lease_token: leaseToken,
  });
  // An uncertain commit must retain its object: deleting it could destroy a committed session.
  if (error) throw new Error("Encrypted worker session update could not be confirmed");
  if (data === null) {
    await discardWorkerSessionObject(client, key);
    return null;
  }
  if (!revision(data) || data !== expectedVersion + 1)
    throw new Error("Invalid worker session persistence response");
  // A successful version CAS proves this observed pointer was the previous version.
  // Fresh random object names ensure cleanup cannot delete the newly committed object.
  if (previous?.version === expectedVersion && previous.key !== key)
    await discardWorkerSessionObject(client, previous.key);
  return data;
}

export async function getSupabaseLaborEncryptedWorkerSession(): Promise<{
  bytes: Uint8Array;
  version: number;
} | null> {
  target();
  const client = createServiceRoleClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const pointer = await workerSessionPointer(client);
    if (!pointer) return null;
    const download = await client.storage.from(LABOR_WORKER_SESSIONS_BUCKET).download(pointer.key);
    // A confirmed replacement can prune this object between the pointer read and download.
    if (download.error && missing(download.error) && attempt === 0) continue;
    if (
      download.error ||
      !download.data ||
      download.data.size === 0 ||
      download.data.size > MAX_SESSION_BYTES
    )
      throw new Error("Encrypted worker session could not be loaded");
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    if (digest(bytes) !== pointer.hash)
      throw new Error("Encrypted worker session checksum mismatch");
    return { bytes, version: pointer.version };
  }
  throw new Error("Encrypted worker session could not be loaded");
}
