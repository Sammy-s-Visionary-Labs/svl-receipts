import { authErrorResponse } from "@/lib/auth/guards";
import { requireCronSecret } from "@/lib/cron/secret";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { runWorkBatch } from "@/lib/work/runner";

// Includes after() work: provider timeout plus image preparation and persistence.
export const maxDuration = 180;

async function run(request: Request) {
  try {
    requireCronSecret(request);
    const result = await runWorkBatch();
    console.info("[work-runner]", result);
    return Response.json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
