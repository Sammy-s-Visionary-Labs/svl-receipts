import { authErrorResponse, requireManager } from "@/lib/auth/guards";

type DeadLetterRow = {
  id: string;
  receipt_id: string;
  kind: string;
  attempt_count: number;
  last_error: string | null;
  terminal_reason: string | null;
  updated_at: string;
};

export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET /api/manager/dead-letters");
    const { data, error } = await supabase
      .from("work_items")
      .select("id, receipt_id, kind, attempt_count, last_error, terminal_reason, updated_at")
      .eq("status", "dead_letter")
      .order("updated_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("[dead-letters]", error);
      return Response.json(
        { error: { code: "internal", message: "Request failed" } },
        { status: 500 },
      );
    }

    const items = ((data ?? []) as DeadLetterRow[]).map((row) => ({
      id: row.id,
      receiptId: row.receipt_id,
      kind: row.kind,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      terminalReason: row.terminal_reason,
      updatedAt: row.updated_at,
    }));

    return Response.json({ items });
  } catch (error) {
    return authErrorResponse(error);
  }
}
