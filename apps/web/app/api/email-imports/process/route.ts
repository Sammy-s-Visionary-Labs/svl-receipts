import { authErrorResponse } from "@/lib/auth/guards";
import { requireEmailImporter } from "@/lib/email/config";
import { recordEmailContact, runEmailImportBatch } from "@/lib/email/importer";
import { HttpError, httpErrorResponse } from "@/lib/http";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    requireEmailImporter(request);
    await recordEmailContact();
    return Response.json(await runEmailImportBatch(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
