import { requireLaborWorker } from "@/lib/labor/access";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { claimLaborWorker } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireLaborWorker(request);
    const body = await boundedJson(request, 1024);
    if (typeof body.runId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.runId))
      throw new Error("Invalid worker run ID");
    return laborResponse({ claim: await claimLaborWorker(body.runId) });
  } catch (error) {
    return laborError(error);
  }
}
