import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { managerJob } from "@/lib/manager/detail";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET manager jobs");
    const p = new URL(request.url).searchParams;
    const search = (p.get("search") ?? "").trim();
    if (search.length > 120 || !["all", "active"].includes(p.get("scope") ?? "active"))
      throw new HttpError(400, "invalid_request", "Invalid job search");
    const { data, error } = await supabase.rpc("manager_search_jobs", {
      p_search: search,
      p_active: (p.get("scope") ?? "active") === "active",
      p_limit: 50,
    });
    if (error) throw error;
    return Response.json(
      { jobs: (data ?? []).map(managerJob) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
