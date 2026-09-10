import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { housecallJobWindow } from "@/lib/housecall/catalog-policy";
import { housecallConfiguration } from "@/lib/housecall/config";
import { syncHousecallJobs } from "@/lib/housecall/jobs";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { managerJob } from "@/lib/manager/detail";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET manager jobs");
    const p = new URL(request.url).searchParams;
    const search = (p.get("search") ?? "").trim();
    if (search.length > 120 || !["all", "active"].includes(p.get("scope") ?? "all"))
      throw new HttpError(400, "invalid_request", "Invalid job search");
    const window = housecallJobWindow();
    const { data, error } = await supabase.rpc("manager_search_housecall_jobs", {
      p_search: search,
      p_active: (p.get("scope") ?? "all") === "active",
      p_limit: 50,
      p_recent_since: window.recentSince,
      p_upcoming_until: window.upcomingUntil,
    });
    if (error) throw error;
    return Response.json(
      {
        jobs: (data ?? [])
          .filter(
            (row: { source?: string }) =>
              !housecallConfiguration().allJobs || row.source === "housecall",
          )
          .map(managerJob),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}

export const maxDuration = 180;
/** Refresh changes only the local catalog; all provider requests are GET. */
export async function POST(request: Request) {
  try {
    await requireManager(request, "POST manager jobs refresh");
    if (!housecallConfiguration().readsEnabled)
      throw new HttpError(503, "reads_disabled", "Housecall job refresh is unavailable.");
    return Response.json(await syncHousecallJobs({ full: true }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
