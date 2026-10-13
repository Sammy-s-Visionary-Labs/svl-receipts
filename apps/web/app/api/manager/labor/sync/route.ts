import { requireLaborAccess } from "@/lib/labor/access";
import { dispatchLaborWorker } from "@/lib/labor/dispatch";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { queueLaborSync } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    const body = await boundedJson(request);
    if (!["run", "connect", "pause", "resume"].includes(String(body.action)))
      throw new Error("Invalid sync action");
    if (
      body.hour !== undefined &&
      (!Number.isInteger(body.hour) || Number(body.hour) < 0 || Number(body.hour) > 23)
    )
      throw new Error("Schedule hour must be 0–23");
    if (
      body.lookbackDays !== undefined &&
      (!Number.isInteger(body.lookbackDays) ||
        Number(body.lookbackDays) < 1 ||
        Number(body.lookbackDays) > 31)
    )
      throw new Error("Lookback must be 1–31 days");
    const sync = await queueLaborSync(
      body.action as "run" | "connect" | "pause" | "resume",
      {
        hour: body.hour as number | undefined,
        lookbackDays: body.lookbackDays as number | undefined,
      },
      actor?.userId === "local-development" ? null : (actor?.userId ?? null),
    );
    const dispatch = body.action === "run" ? await dispatchLaborWorker() : undefined;
    return laborResponse({ sync, dispatch });
  } catch (error) {
    return laborError(error);
  }
}
