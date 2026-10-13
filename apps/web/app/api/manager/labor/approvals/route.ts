import { AuthHttpError } from "@/lib/auth/guards";
import { requireLaborAccess } from "@/lib/labor/access";
import { laborApprovalAction, loadLaborApprovalWorkspace } from "@/lib/labor/approval-service";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    if (!actor) throw new AuthHttpError(403, "forbidden", "Manager access required.");
    const query = new URL(request.url).searchParams;
    return laborResponse(
      await loadLaborApprovalWorkspace({
        housecallJobId: query.get("housecallJobId"),
        fromDate: query.get("fromDate"),
        toDate: query.get("toDate"),
        ...(query.has("workers")
          ? { workerNames: JSON.parse(query.get("workers") ?? "null") }
          : {}),
      }),
    );
  } catch (error) {
    return laborError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    if (!actor) throw new AuthHttpError(403, "forbidden", "Manager access required.");
    return laborResponse(await laborApprovalAction(await boundedJson(request), actor.userId));
  } catch (error) {
    return laborError(error);
  }
}
