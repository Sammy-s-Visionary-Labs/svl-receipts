import { requireLaborAccess } from "@/lib/labor/access";
import { laborError, laborResponse } from "@/lib/labor/http";
import { loadJobsDashboard } from "@/lib/labor/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireLaborAccess(request);
    return laborResponse(await loadJobsDashboard(supabase), 200, { stream: true });
  } catch (error) {
    return laborError(error);
  }
}
