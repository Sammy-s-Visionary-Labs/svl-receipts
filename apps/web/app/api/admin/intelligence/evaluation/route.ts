import { createHmac, randomBytes } from "node:crypto";
import { sanitizeFeedbackRecords } from "@svl/domain";
import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { UUID } from "@/lib/manager/review-request";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin(request, "GET sanitized intelligence evaluation");
    const cursor = new URL(request.url).searchParams.get("cursor");
    let before: { at: string; id: string } | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          typeof parsed.at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/.test(parsed.at) ||
          !Number.isFinite(Date.parse(parsed.at)) ||
          typeof parsed.id !== "string" ||
          !UUID.test(parsed.id)
        )
          throw new Error("invalid");
        before = parsed;
      } catch {
        throw new HttpError(400, "invalid_request", "Invalid export cursor.");
      }
    }
    let requestQuery = supabase
      .from("receipt_intelligence_feedback")
      .select(
        "id,receipt_id,review_id,actor_id,field_path,suggested_value,final_value,accepted,model,prompt_version,scoring_version,created_at,review:reviews(decision,version)",
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(501);
    if (before)
      requestQuery = requestQuery.or(
        `created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`,
      );
    const { data, error } = await requestQuery;
    if (error) throw error;
    const rows = (data ?? []).slice(0, 500);
    const salt = randomBytes(32);
    const tokenize = (value: string) =>
      createHmac("sha256", salt).update(value).digest("hex").slice(0, 24);
    const records = sanitizeFeedbackRecords(
      rows.map((row) => ({
        ...row,
        review: Array.isArray(row.review) ? row.review[0] : row.review,
      })),
      tokenize,
    );
    const last = rows.at(-1);
    const nextCursor =
      (data?.length ?? 0) > 500 && last
        ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString("base64url")
        : null;
    return Response.json(
      {
        schemaVersion: 1,
        records,
        nextCursor,
        nextPage: nextCursor ? `/api/admin/intelligence/evaluation?cursor=${nextCursor}` : null,
        notice:
          "Text and identities are pseudonymized within this export page. Review regression results before changing prompts or scoring; feedback never tunes production automatically.",
      },
      {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": "attachment; filename=ra5-evaluation.json",
        },
      },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
