import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createOrResumeUploadSession } from "@/lib/upload/sessions";

export async function POST(request: Request) {
  try {
    const { actor } = await requireActor(request, "POST /api/upload-sessions");
    return Response.json(await createOrResumeUploadSession(actor.userId, await readJson(request)));
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
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
