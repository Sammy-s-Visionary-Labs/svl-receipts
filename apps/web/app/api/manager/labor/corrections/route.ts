import { AuthHttpError } from "@/lib/auth/guards";
import { requireLaborAccess } from "@/lib/labor/access";
import { listLaborManualCorrections, recordLaborManualCorrection } from "@/lib/labor/corrections";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    if (!actor) throw new AuthHttpError(403, "forbidden", "Manager access required.");
    return laborResponse(
      await listLaborManualCorrections(
        new URL(request.url).searchParams.get("approvalId"),
        actor.userId,
      ),
    );
  } catch (error) {
    return laborError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    if (!actor) throw new AuthHttpError(403, "forbidden", "Manager access required.");
    return laborResponse(
      await recordLaborManualCorrection(await boundedJson(request, 48 * 1024), actor.userId),
    );
  } catch (error) {
    return laborError(error);
  }
}
