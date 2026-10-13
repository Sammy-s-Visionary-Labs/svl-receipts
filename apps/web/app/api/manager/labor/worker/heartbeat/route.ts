import { requireLaborWorker } from "@/lib/labor/access";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { heartbeatLaborWorker } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireLaborWorker(request);
    const body = await boundedJson(request, 1024);
    if (body.status !== "running" || typeof body.leaseToken !== "string")
      throw new Error("Invalid worker heartbeat");
    return laborResponse({ sync: await heartbeatLaborWorker(body.leaseToken) });
  } catch (error) {
    return laborError(error);
  }
}
