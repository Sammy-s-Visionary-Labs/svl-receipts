import { randomUUID } from "node:crypto";
import type { ApproveLineAssignment } from "@svl/domain";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { kickWork } from "@/lib/work/runner";

type RouteContext = { params: Promise<{ id: string }> };

type ApproveBody = {
  lines?: unknown;
  edits?: unknown;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { actor } = await requireManager(request, "POST /api/receipts/[id]/approve");
    const body = (await readJson(request)) as ApproveBody;
    const lines = parseApproveLines(body.lines);

    const service = createServiceRoleClient();
    const { data, error } = await service.rpc("approve_receipt_with_outbox", {
      p_receipt_id: id,
      p_actor_id: actor.userId,
      p_lines: lines,
      p_edits: body.edits ?? null,
      p_correlation_id: randomUUID(),
    });
    if (error) {
      throw rpcHttpError(error);
    }

    try {
      await kickWork("export");
    } catch (cause) {
      console.error("[approve] kick export", cause);
    }

    return Response.json(data);
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

function parseApproveLines(value: unknown): ApproveLineAssignment[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "invalid_request", "lines are required to approve");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new HttpError(400, "invalid_request", "each line needs job_id and description");
    }
    const line = item as Record<string, unknown>;
    if (
      typeof line.job_id !== "string" ||
      line.job_id.trim() === "" ||
      typeof line.description !== "string" ||
      line.description.trim() === "" ||
      typeof line.qty !== "number" ||
      typeof line.unit_cost_cents !== "number"
    ) {
      throw new HttpError(400, "invalid_request", "each line needs job_id and description");
    }
    return {
      description: line.description,
      qty: line.qty,
      uom: typeof line.uom === "string" ? line.uom : undefined,
      unit_cost_cents: line.unit_cost_cents,
      job_id: line.job_id,
    };
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON");
  }
}
