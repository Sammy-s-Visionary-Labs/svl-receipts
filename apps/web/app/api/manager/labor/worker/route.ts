import { AuthHttpError } from "@/lib/auth/guards";
import { isLaborWorker, requireLaborDevelopment, requireLaborWorker } from "@/lib/labor/access";
import type { LaborSyncState } from "@/lib/labor/contract";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { loadLaborWorkerPoll, updateLaborWorker } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function authorize(request: Request) {
  requireLaborDevelopment(request);
  if (!isLaborWorker(request))
    throw new AuthHttpError(401, "unauthenticated", "Development worker token required");
}
export async function GET(request: Request) {
  try {
    requireLaborWorker(request);
    return laborResponse(await loadLaborWorkerPoll());
  } catch (error) {
    return laborError(error);
  }
}
export async function POST(request: Request) {
  try {
    authorize(request);
    const body = await boundedJson(request);
    if (!["idle", "running", "needs_login", "failed"].includes(String(body.status)))
      throw new Error("Invalid worker status");
    const patch: Partial<LaborSyncState> = { status: body.status as LaborSyncState["status"] };
    if (body.lastError !== undefined) {
      if (
        body.lastError !== null &&
        (typeof body.lastError !== "string" || body.lastError.length > 500)
      )
        throw new Error("Invalid worker error");
      patch.lastError = body.lastError as string | null;
    }
    if (body.commandId !== undefined) {
      if (typeof body.commandId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.commandId))
        throw new Error("Invalid command ID");
      patch.commandId = body.commandId;
    }
    for (const key of ["lastAttemptAt", "lastSuccessAt", "nextRunAt"] as const) {
      if (body[key] !== undefined) {
        if (
          body[key] !== null &&
          (typeof body[key] !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T/.test(body[key] as string) ||
            !Number.isFinite(Date.parse(body[key] as string)))
        )
          throw new Error("Invalid worker timestamp");
        patch[key] = body[key] as string | null;
      }
    }
    return laborResponse({ sync: await updateLaborWorker(patch) });
  } catch (error) {
    return laborError(error);
  }
}
