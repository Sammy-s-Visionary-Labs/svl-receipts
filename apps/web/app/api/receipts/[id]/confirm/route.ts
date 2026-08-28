import { authErrorResponse } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { confirmReceiptUpload } from "@/lib/upload/confirmation";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return Response.json(await confirmReceiptUpload(request, id));
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}
