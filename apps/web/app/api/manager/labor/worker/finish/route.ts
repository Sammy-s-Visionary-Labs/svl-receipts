import { requireLaborWorker } from "@/lib/labor/access";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { finishLaborWorker } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireLaborWorker(request);
    const body = await boundedJson(request, 2048);
    if (
      typeof body.leaseToken !== "string" ||
      !["idle", "needs_login", "failed"].includes(String(body.status))
    )
      throw new Error("Invalid worker finish status");
    if (
      body.lastError != null &&
      (typeof body.lastError !== "string" || body.lastError.length > 500)
    )
      throw new Error("Invalid worker error");
    return laborResponse({
      sync: await finishLaborWorker(
        body.leaseToken,
        body.status as "idle" | "needs_login" | "failed",
        body.lastError as string | null | undefined,
      ),
    });
  } catch (error) {
    return laborError(error);
  }
}
