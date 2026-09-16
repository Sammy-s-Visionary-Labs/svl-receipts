import { authErrorResponse } from "@/lib/auth/guards";
import { readSmallJson, requireEmailImporter } from "@/lib/email/config";
import { initializeEmailImport, recordEmailContact } from "@/lib/email/importer";
import { HttpError, httpErrorResponse } from "@/lib/http";
export async function POST(request: Request) {
  try {
    const { ownerId } = requireEmailImporter(request);
    await recordEmailContact();
    return Response.json(await initializeEmailImport(await readSmallJson(request), ownerId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
