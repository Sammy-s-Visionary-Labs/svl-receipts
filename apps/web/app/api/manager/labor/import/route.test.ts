import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), labor: vi.fn(), notes: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/store", () => ({
  ingestLaborFile: mocks.labor,
  ingestLaborNotesFile: mocks.notes,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ worker: false });
  mocks.labor.mockResolvedValue({ duplicate: false });
  mocks.notes.mockResolvedValue({ duplicate: false });
});
function upload(fields: Record<string, string> = {}, paired = false) {
  const form = new FormData();
  form.set("file", new File(["TEST-XLSX"], "TEST.xlsx"));
  if (paired) form.set("notesFile", new File(["TEST-NOTES"], "TEST-notes.xlsx"));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://127.0.0.1:3145/api/manager/labor/import", {
    method: "POST",
    body: form,
  });
}

describe("paired Supercrew import contract", () => {
  it("rejects a recurring timesheet without notes before ingesting hours", async () => {
    mocks.access.mockResolvedValue({ worker: true });
    const response = await POST(upload({ periodStart: "2026-09-24", periodEnd: "2026-09-30" }));
    expect(response.status).toBe(400);
    expect(mocks.labor).not.toHaveBeenCalled();
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("passes the paired files and exact worker period into one atomic ingestion", async () => {
    mocks.access.mockResolvedValue({ worker: true });
    const response = await POST(
      upload(
        { periodStart: "2026-09-24", periodEnd: "2026-09-30", notesScope: "daily_timesheet" },
        true,
      ),
    );
    expect(response.status).toBe(201);
    expect(mocks.labor).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "TEST.xlsx",
      "supercrew",
      { from: "2026-09-24", to: "2026-09-30" },
      expect.objectContaining({
        scope: "daily_timesheet",
        complete: true,
        datesVerified: true,
        filename: "TEST-notes.xlsx",
        bytes: expect.any(Uint8Array),
      }),
      null,
      undefined,
    );
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("requires calendar-valid acquisition dates for a manual Notes Report", async () => {
    const response = await POST(
      upload({ kind: "notes", periodStart: "2026-02-30", periodEnd: "2026-03-01" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("cannot activate notes alone through the recurring worker identity", async () => {
    mocks.access.mockResolvedValue({ worker: true });
    const response = await POST(
      upload({
        kind: "notes",
        periodStart: "2026-09-24",
        periodEnd: "2026-09-30",
        notesScope: "daily_timesheet",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("does not let a manual file claim that Note Type was verified by the worker", async () => {
    const response = await POST(
      upload({
        kind: "notes",
        periodStart: "2026-09-24",
        periodEnd: "2026-09-30",
        notesScope: "daily_timesheet",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("preserves unverified coverage unless declared and retains normal source uploads", async () => {
    expect(
      (await POST(upload({ kind: "notes", periodStart: "2026-09-24", periodEnd: "2026-09-30" })))
        .status,
    ).toBe(201);
    expect(mocks.notes).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "TEST.xlsx",
      "upload",
      { from: "2026-09-24", to: "2026-09-30" },
      { scope: "mixed", complete: false, datesVerified: false },
      null,
    );
    expect((await POST(upload())).status).toBe(201);
    expect(mocks.labor).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "TEST.xlsx",
      "upload",
      undefined,
      undefined,
      null,
      undefined,
    );
  });
});
