import { requireLaborAccess } from "@/lib/labor/access";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { updateLaborRules } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    const input = await boundedJson(request, 256 * 1024);
    return laborResponse(
      await updateLaborRules(
        input.rules,
        input.expectedRevision,
        actor?.userId === "local-development" ? null : (actor?.userId ?? null),
      ),
    );
  } catch (error) {
    return laborError(error);
  }
}
