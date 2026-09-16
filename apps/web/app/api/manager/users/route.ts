import { accountBody } from "@/lib/accounts/requests";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { UUID } from "@/lib/manager/review-request";

const privateHeaders = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const { actor, supabase } = await requireManager(request, "GET workspace users");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 0);
    const status = url.searchParams.get("status") ?? "pending";
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page > 10000 ||
      !["pending", "approved", "rejected"].includes(status)
    )
      throw new HttpError(400, "invalid_request", "Invalid account list");
    let query = supabase
      .from("profiles")
      .select("id,full_name,email,phone,role,disabled,access_status,access_version,created_at", {
        count: "exact",
      })
      .eq("access_status", status)
      .order("created_at", { ascending: false })
      .order("id")
      .range(page * 50, page * 50 + 49);
    if (actor.role === "manager") query = query.eq("role", "worker");
    const { data, error, count } = await query;
    if (error) throw error;
    return Response.json({ users: data ?? [], total: count ?? 0 }, { headers: privateHeaders });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const { supabase } = await requireManager(request, "POST workspace user access");
    const body = await accountBody(request);
    if (
      typeof body.userId !== "string" ||
      !UUID.test(body.userId) ||
      !["approve", "reject", "disable", "enable", "role"].includes(String(body.action)) ||
      !Number.isInteger(body.version) ||
      Number(body.version) < 0 ||
      (body.action === "role" && !["worker", "manager", "admin"].includes(String(body.role)))
    )
      throw new HttpError(400, "invalid_request", "Invalid account change");
    const { error } = await supabase.rpc("manage_workspace_user", {
      p_target_id: body.userId,
      p_action: body.action,
      p_expected_version: body.version,
      p_role: body.action === "role" ? body.role : null,
    });
    if (error) {
      if (error.code === "42501")
        throw new HttpError(
          403,
          "forbidden",
          "You cannot change this account. Managers can only manage workers; an administrator must change roles.",
        );
      if (error.message.includes("last_admin"))
        throw new HttpError(409, "last_admin", "Keep at least one active administrator.");
      if (
        error.message.includes("account_changed") ||
        error.message.includes("invalid_account_action")
      )
        throw new HttpError(
          409,
          "account_changed",
          "This account changed. Refresh the list before trying again.",
        );
      throw error;
    }
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
