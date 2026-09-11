import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { syncHousecallJobs } from "@/lib/housecall/jobs";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    await requireAdmin(request, "POST Housecall job sync");
    // Explicit admin refresh scans the complete catalog; HCP access is GET only.
    return Response.json(await syncHousecallJobs({ full: true }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
