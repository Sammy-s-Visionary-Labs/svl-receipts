import { authErrorResponse } from "@/lib/auth/guards";
import { requireCronSecret } from "@/lib/cron/secret";
import { emailConfig } from "@/lib/email/config";
import { runEmailImportBatch } from "@/lib/email/importer";
import { HttpError, httpErrorResponse } from "@/lib/http";
export const maxDuration = 180;
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    emailConfig();
    return Response.json(await runEmailImportBatch());
  } catch (error) {
    if (error instanceof HttpError && error.code === "email_not_configured")
      return Response.json({ skipped: "not_configured" });
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
