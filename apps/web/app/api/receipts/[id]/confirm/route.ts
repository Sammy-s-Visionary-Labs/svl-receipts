import { after } from "next/server";
import { authErrorResponse } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { confirmReceiptUpload } from "@/lib/upload/confirmation";
import { kickWork } from "@/lib/work/runner";

type RouteContext = { params: Promise<{ id: string }> };

export const maxDuration = 60;

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const result = await confirmReceiptUpload(request, id);
    after(async () => {
      try {
        await kickWork("readability");
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
