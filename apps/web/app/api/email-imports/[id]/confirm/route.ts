import { after } from "next/server";
import { authErrorResponse } from "@/lib/auth/guards";
import { requireEmailImporter } from "@/lib/email/config";
import { confirmEmailImport, runEmailImportBatch } from "@/lib/email/importer";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireEmailImporter(request);
    const { id } = await context.params;
    validId(id);
    const result = await confirmEmailImport(id);
    after(async () => {
      try {
        await runEmailImportBatch(id);
      } catch {
        console.error("[email-import] background work deferred");
      }
    });
    return Response.json(result, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
