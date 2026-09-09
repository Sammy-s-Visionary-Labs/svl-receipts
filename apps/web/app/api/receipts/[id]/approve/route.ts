import { POST as review } from "@/app/api/manager/receipts/[id]/review/route";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReviewBody } from "@/lib/manager/review-request";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await readReviewBody(request);
    if (body.decision !== "approve")
      throw new HttpError(400, "invalid_request", "Use the versioned approve command");
    return review(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      context,
    );
  } catch (error) {
    if (error instanceof HttpError) return httpErrorResponse(error);
    throw error;
  }
}
