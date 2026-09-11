import { authErrorResponse } from "@/lib/auth/guards";
import { requireCronSecret } from "@/lib/cron/secret";
import { runApprovedHousecallExports } from "@/lib/housecall/export";
import { syncHousecallJobs } from "@/lib/housecall/jobs";
import { HttpError, httpErrorResponse } from "@/lib/http";
export const maxDuration = 180;
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const deadlineAt = Date.now() + 150_000;
    const sync = await syncHousecallJobs({ deadlineAt: deadlineAt - 55_000 });
    const exports = await runApprovedHousecallExports({ deadlineAt });
    return Response.json({ sync, exports });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
