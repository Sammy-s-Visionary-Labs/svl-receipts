import { after } from "next/server";
import { authErrorResponse } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { confirmReceiptUpload } from "@/lib/upload/confirmation";
import { runReceiptWork, WORK_REQUEST_BUDGET_MS } from "@/lib/work/runner";

type RouteContext = { params: Promise<{ id: string }> };

// Includes after() work: provider timeout plus image preparation and persistence.
export const maxDuration = 180;

export async function POST(request: Request, context: RouteContext) {
  const deadlineAt = Date.now() + WORK_REQUEST_BUDGET_MS;
  try {
    const { id } = await context.params;
    const result = await confirmReceiptUpload(request, id);
    after(async () => {
      try {
        await runReceiptWork(id, "readability", { deadlineAt });
      } catch (cause) {
        console.error("[upload-confirm] kick readability", {
          receiptId: id,
          cause: cause instanceof Error ? cause.name : "unknown",
        });
      }
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}
