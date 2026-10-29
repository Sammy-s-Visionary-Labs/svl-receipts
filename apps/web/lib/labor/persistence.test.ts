import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  createSignedUrl: vi.fn(),
  remove: vi.fn(),
  storageFrom: vi.fn(),
  tableFrom: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
    from: mocks.tableFrom,
  }),
}));

let persistence: typeof import("./persistence");
const id = "42000000-0000-4000-8000-000000000001";
const notesId = "42000000-0000-4000-8000-000000000002";
const actor = "42000000-0000-4000-8000-000000000003";
const hash = "a".repeat(64);
const bytes = new Uint8Array([80, 75, 3, 4, 1, 2]);
const state = () => ({
  version: 1,
  imports: [{ id, hash, filename: "TEST.xlsx", report: { entries: [] } }],
  notesImports: [{ id: notesId, hash, filename: "TEST-notes.xlsx", report: { notes: [] } }],
  sync: { status: "connected", workerHeartbeatAt: "2026-10-13T00:00:00Z" },
  paySettings: { workerRates: [{ workerName: "TEST worker", regularRate: 25 }] },
  rulesRevision: 0,
});
const emptyManifest = { data: { revision: 0, manifest: [] }, error: null };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.storageFrom.mockReturnValue({
    upload: mocks.upload,
    download: mocks.download,
    createSignedUrl: mocks.createSignedUrl,
    remove: mocks.remove,
  });
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: mocks.maybeSingle };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.tableFrom.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  persistence = await import("./persistence");
});

describe("shared labor state", () => {
  it("uses the locked worker import RPC only with an explicit valid lease guard", async () => {
    const guard = {
      leaseToken: id,
      commandId: notesId,
      period: { from: "2026-09-24", to: "2026-09-30" },
    };
    mocks.rpc.mockResolvedValueOnce(emptyManifest).mockResolvedValueOnce({ data: 1, error: null });
    expect(await persistence.compareAndSwapSupabaseLaborState(state(), 0, null, guard)).toBe(1);
    expect(mocks.rpc.mock.calls[1][0]).toBe("compare_and_swap_labor_state_leased");
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
      p_expected_revision: 0,
      p_lease_token: id,
      p_command_id: notesId,
      p_period_start: "2026-09-24",
      p_period_end: "2026-09-30",
    });
    expect(mocks.rpc.mock.calls[1][1]).not.toHaveProperty("p_actor_id");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await persistence.compareAndSwapSupabaseLaborState(state(), 1, null, guard)).toBeNull();
    expect(mocks.rpc.mock.lastCall?.[0]).toBe("compare_and_swap_labor_state_leased");
    await expect(
      persistence.compareAndSwapSupabaseLaborState(state(), 0, actor, guard),
    ).rejects.toThrow("lease guard");
    await expect(
      persistence.compareAndSwapSupabaseLaborState(state(), 0, null, {
        ...guard,
        period: { from: "2026-02-30", to: "2026-09-30" },
      }),
    ).rejects.toThrow("lease guard");
    await expect(
      persistence.compareAndSwapSupabaseLaborState(state(), 0, null, {
        ...guard,
        leaseToken: "bad",
      }),
    ).rejects.toThrow("lease guard");
  });

  it("returns null only for an uninitialized snapshot and masks provider details", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await persistence.readSupabaseLaborState()).toBeNull();
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "private connection secret" },
    });
    await expect(persistence.readSupabaseLaborState()).rejects.toThrow(
      "Labor state could not be loaded",
    );
  });

  it("stores sources separately and sends no report delta for a heartbeat", async () => {
    mocks.rpc.mockResolvedValueOnce(emptyManifest).mockResolvedValueOnce({ data: 1, error: null });
    const original = state();
    expect(await persistence.compareAndSwapSupabaseLaborState(original, 0, actor)).toBe(1);
    const initial = mocks.rpc.mock.calls[1][1];
    expect(initial.p_control).not.toHaveProperty("imports");
    expect(initial.p_control).not.toHaveProperty("notesImports");
    expect(initial.p_control.paySettings).toEqual(original.paySettings);
    expect(initial.p_changed_imports).toHaveLength(2);
    expect(initial.p_changed_imports[0].summary).not.toHaveProperty("report");
    expect(initial.p_actor_id).toBe(actor);

    mocks.rpc.mockResolvedValueOnce({ data: 2, error: null });
    const heartbeat = state();
    heartbeat.sync.workerHeartbeatAt = "2026-10-13T00:00:15Z";
    expect(await persistence.compareAndSwapSupabaseLaborState(heartbeat, 1, null)).toBe(2);
    const delta = mocks.rpc.mock.calls[2][1];
    expect(delta.p_changed_imports).toEqual([]);
    expect(delta.p_manifest).toHaveLength(2);
    expect(delta.p_actor_id).toBeNull();
  });

  it("changes only the affected parsed record and retains ordinal manifests", async () => {
    mocks.rpc.mockResolvedValueOnce(emptyManifest).mockResolvedValueOnce({ data: 1, error: null });
    await persistence.compareAndSwapSupabaseLaborState(state(), 0, actor);
    const changed = state();
    changed.imports[0].filename = "updated metadata.xlsx";
    mocks.rpc.mockResolvedValueOnce({ data: 2, error: null });
    await persistence.compareAndSwapSupabaseLaborState(changed, 1, actor);
    const patch = mocks.rpc.mock.calls[2][1];
    expect(patch.p_changed_imports).toHaveLength(1);
    expect(patch.p_changed_imports[0].id).toBe(id);
    expect(patch.p_manifest.map((row: { position: number }) => row.position)).toEqual([0, 0]);
  });

  it("checks the DB revision on cache reads and isolates returned state from callers", async () => {
    mocks.rpc.mockResolvedValueOnce(emptyManifest).mockResolvedValueOnce({ data: 1, error: null });
    await persistence.compareAndSwapSupabaseLaborState(state(), 0, actor);
    mocks.rpc.mockResolvedValue({ data: { revision: 1, unchanged: true }, error: null });
    const first = await persistence.readSupabaseLaborState();
    if (!first) throw new Error("Expected initialized state");
    (first.state.imports as unknown[]).pop();
    const second = await persistence.readSupabaseLaborState();
    expect(second?.state.imports).toHaveLength(1);
    expect(mocks.rpc.mock.calls.at(-1)).toEqual(["read_labor_state", { p_known_revision: 1 }]);
  });

  it("reloads a changed snapshot with its report hashes and fails closed on invalid replies", async () => {
    const reply = {
      revision: 4,
      state: state(),
      manifest: [
        { id, kind: "timesheet", position: 0, content_hash: hash },
        { id: notesId, kind: "notes", position: 0, content_hash: hash },
      ],
    };
    mocks.rpc.mockResolvedValueOnce({ data: reply, error: null });
    expect(await persistence.readSupabaseLaborState()).toEqual({ state: state(), revision: 4 });
    mocks.rpc.mockResolvedValueOnce({ data: { revision: 5, unchanged: true }, error: null });
    await expect(persistence.readSupabaseLaborState()).rejects.toThrow(
      "Invalid labor persistence response",
    );
  });

  it("rejects stale initialization and a writer losing CAS without overwriting newer state", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { revision: 1, manifest: [] }, error: null });
    expect(await persistence.compareAndSwapSupabaseLaborState(state(), 0, actor)).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.rpc.mockResolvedValueOnce({ data: { revision: 1, manifest: [] }, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await persistence.compareAndSwapSupabaseLaborState(state(), 1, actor)).toBeNull();
  });

  it("rejects duplicate source IDs, bad hashes and invalid revisions before external I/O", async () => {
    const duplicate = state();
    duplicate.notesImports[0].id = id;
    await expect(persistence.compareAndSwapSupabaseLaborState(duplicate, 0, actor)).rejects.toThrow(
      "Invalid labor source record",
    );
    await expect(persistence.compareAndSwapSupabaseLaborState(state(), -1, actor)).rejects.toThrow(
      "Invalid labor update revision",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("private labor originals", () => {
  it("signs only the requested immutable workbook for a one-minute attachment download", async () => {
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.example.invalid/private/TEST.xlsx?token=TEST" },
      error: null,
    });
    expect(await persistence.createSupabaseLaborOriginalDownloadUrl(id, "TEST report.xlsx")).toBe(
      "https://storage.example.invalid/private/TEST.xlsx?token=TEST",
    );
    expect(mocks.storageFrom).toHaveBeenCalledWith("labor-originals");
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(`${id}.xlsx`, 60, {
      download: "TEST report.xlsx",
    });
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(
      persistence.createSupabaseLaborOriginalDownloadUrl("../private", "TEST.xlsx"),
    ).rejects.toThrow("identifier");
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: "private secret" } });
    await expect(
      persistence.createSupabaseLaborOriginalDownloadUrl(id, "TEST.xlsx"),
    ).rejects.toThrow("Labor original could not be loaded");
  });

  it("uses bounded immutable uploads and accepts only byte-identical retries", async () => {
    mocks.upload.mockResolvedValueOnce({ error: null });
    await persistence.putSupabaseLaborOriginal(id, bytes);
    expect(mocks.storageFrom).toHaveBeenCalledWith("labor-originals");
    expect(mocks.upload).toHaveBeenCalledWith(
      `${id}.xlsx`,
      bytes,
      expect.objectContaining({ upsert: false }),
    );
    mocks.upload.mockResolvedValue({ error: { code: "ResourceAlreadyExists" } });
    mocks.download.mockResolvedValueOnce({ data: new Blob([bytes]), error: null });
    await expect(persistence.putSupabaseLaborOriginal(id, bytes)).resolves.toBeUndefined();
    mocks.download.mockResolvedValueOnce({ data: new Blob([new Uint8Array([9])]), error: null });
    await expect(persistence.putSupabaseLaborOriginal(id, bytes)).rejects.toThrow(
      "different contents",
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("distinguishes missing originals from authorization/storage errors", async () => {
    mocks.download.mockResolvedValueOnce({
      data: null,
      error: { code: "NoSuchKey", statusCode: "404" },
    });
    expect(await persistence.getSupabaseLaborOriginal(id)).toBeNull();
    mocks.download.mockResolvedValueOnce({
      data: null,
      error: { code: "AccessDenied", statusCode: "403" },
    });
    await expect(persistence.getSupabaseLaborOriginal(id)).rejects.toThrow("could not be loaded");
    await expect(persistence.getSupabaseLaborOriginal("../../secret")).rejects.toThrow(
      "identifier",
    );
    await expect(
      persistence.putSupabaseLaborOriginal(id, new Uint8Array(10 * 1024 * 1024 + 1)),
    ).rejects.toThrow("size limit");
  });
});

describe("encrypted worker session", () => {
  const pointer = (version = 3, objectId = id) => ({
    data: {
      version,
      object_key: `${objectId}.bin`,
      content_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    error: null,
  });

  it("prunes only the observed previous version after the new pointer commits", async () => {
    mocks.maybeSingle.mockResolvedValue(pointer());
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({ data: 4, error: null });
    mocks.remove.mockResolvedValue({ error: null });
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3, "TEST-lease")).toBe(
      4,
    );
    expect(mocks.remove).toHaveBeenCalledWith([`${id}.bin`]);
    expect(mocks.remove).not.toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );
  });

  it("never prunes a current pointer on a stale or uncertain update", async () => {
    mocks.maybeSingle.mockResolvedValue(pointer());
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    mocks.remove.mockResolvedValue({ error: null });
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).toBeNull();
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]]);
    expect(mocks.remove).not.toHaveBeenCalledWith([`${id}.bin`]);
    mocks.remove.mockClear();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "Uncertain commit" } });
    await expect(persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("retains an observed pointer with a different version and tolerates cleanup failure after commit", async () => {
    mocks.maybeSingle.mockResolvedValue(pointer(2));
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({ data: 4, error: null });
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).toBe(4);
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.maybeSingle.mockResolvedValue(pointer(3));
    mocks.remove.mockRejectedValue(new Error("Temporary storage error"));
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).toBe(4);
  });

  it("rereads the committed pointer when a concurrent replacement prunes the downloaded object", async () => {
    mocks.maybeSingle.mockResolvedValueOnce(pointer(3)).mockResolvedValueOnce(pointer(4, notesId));
    mocks.download
      .mockResolvedValueOnce({ data: null, error: { code: "NoSuchKey", statusCode: "404" } })
      .mockResolvedValueOnce({ data: new Blob([bytes]), error: null });
    expect(await persistence.getSupabaseLaborEncryptedWorkerSession()).toEqual({
      bytes,
      version: 4,
    });
    expect(mocks.download.mock.calls.map((call) => call[0])).toEqual([
      `${id}.bin`,
      `${notesId}.bin`,
    ]);
  });

  it("bounds replacement retries and does not retry nonmissing storage errors", async () => {
    mocks.maybeSingle.mockResolvedValue(pointer());
    mocks.download.mockResolvedValue({
      data: null,
      error: { code: "NoSuchKey", statusCode: "404" },
    });
    await expect(persistence.getSupabaseLaborEncryptedWorkerSession()).rejects.toThrow(
      "could not be loaded",
    );
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    mocks.maybeSingle.mockClear();
    mocks.download.mockResolvedValue({
      data: null,
      error: { code: "AccessDenied", statusCode: "403" },
    });
    await expect(persistence.getSupabaseLaborEncryptedWorkerSession()).rejects.toThrow(
      "could not be loaded",
    );
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("uploads to a fresh object and CAS rejects a stale worker version", async () => {
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValueOnce({ data: 4, error: null });
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3, "TEST-lease")).toBe(
      4,
    );
    const key = mocks.upload.mock.calls[0][0];
    expect(key).toMatch(/^[a-f0-9-]{36}\.bin$/);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "compare_and_swap_labor_worker_session",
      expect.objectContaining({
        p_expected_version: 3,
        p_object_key: key,
        p_lease_token: "TEST-lease",
      }),
    );
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    mocks.remove.mockResolvedValue({ error: null });
    expect(await persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).toBeNull();
    expect(mocks.rpc.mock.calls[1][1].p_lease_token).toBeNull();
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[1][0]]);
    expect(mocks.upload.mock.calls[1][0]).not.toBe(key);
  });

  it("keeps uploaded encrypted bytes after an uncertain CAS response", async () => {
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "network failure" } });
    await expect(persistence.putSupabaseLaborEncryptedWorkerSession(bytes, 3)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("checks stored encrypted bytes against the committed pointer checksum", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        version: 4,
        object_key: `${id}.bin`,
        content_sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      error: null,
    });
    mocks.download.mockResolvedValueOnce({ data: new Blob([bytes]), error: null });
    expect(await persistence.getSupabaseLaborEncryptedWorkerSession()).toEqual({
      bytes,
      version: 4,
    });
    mocks.download.mockResolvedValueOnce({ data: new Blob([new Uint8Array([9])]), error: null });
    await expect(persistence.getSupabaseLaborEncryptedWorkerSession()).rejects.toThrow(
      "checksum mismatch",
    );
  });
});
