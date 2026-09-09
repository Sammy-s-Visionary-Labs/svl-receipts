import { createHousecallClient, HousecallError } from "@svl/integrations";
import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { housecallConfiguration } from "@/lib/housecall/config";
export async function GET(request: Request) {
  try {
    await requireAdmin(request, "GET Housecall health");
    const config = housecallConfiguration();
    const result = {
      configured: config.configured,
      readsEnabled: config.readsEnabled,
      exportMode: config.mode,
      requiresExplicitWriteApproval: true,
    };
    if (!config.readsEnabled || !config.configured)
      return Response.json(
        { ...result, connected: false },
        { headers: { "cache-control": "private, no-store" } },
      );
    try {
      await createHousecallClient({
        apiKey: process.env.HOUSECALL_API_KEY ?? "",
        timeoutMs: 10_000,
      }).checkHealth();
      return Response.json(
        { ...result, connected: true },
        { headers: { "cache-control": "private, no-store" } },
      );
    } catch (error) {
      return Response.json(
        {
          ...result,
          connected: false,
          error: error instanceof HousecallError ? error.code : "connection_failed",
        },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    }
  } catch (error) {
    return authErrorResponse(error);
  }
}
