import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { categoryRow } from "@/lib/manager/intelligence";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET receipt categories");
    const { data, error } = await supabase
      .from("receipt_categories")
      .select("id,label,active,keywords,version")
      .order("label")
      .limit(500);
    if (error) throw error;
    return Response.json(
      { categories: (data ?? []).map(categoryRow) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
