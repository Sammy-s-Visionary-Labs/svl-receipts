import { requireLaborAccess } from "@/lib/labor/access";
import { laborError, laborResponse } from "@/lib/labor/http";
import { loadLaborStatus } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireLaborAccess(request);
    return laborResponse(await loadLaborStatus());
  } catch (error) {
    return laborError(error);
  }
}
