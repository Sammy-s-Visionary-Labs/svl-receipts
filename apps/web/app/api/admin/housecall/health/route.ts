import { HousecallError } from "@svl/integrations";
import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { configuredHousecallClient, housecallConfiguration } from "@/lib/housecall/config";
import { createServiceRoleClient } from "@/lib/supabase/service";
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
    const db = createServiceRoleClient();
    const history = async (connected: boolean | null, error: string | null = null) => {
      const result = await db.rpc("housecall_health_status", {
        p_connected: connected,
        p_error: error,
      });
      if (result.error) throw result.error;
      return result.data ?? {};
    };
    if (!config.readsEnabled || !config.configured)
      return Response.json(
        { ...result, connected: false, ...(await history(null)) },
        { headers: { "cache-control": "private, no-store" } },
      );
    try {
      await configuredHousecallClient(10_000).checkHealth();
      return Response.json(
        { ...result, connected: true, ...(await history(true)) },
        { headers: { "cache-control": "private, no-store" } },
      );
    } catch (error) {
      const code = error instanceof HousecallError ? error.code : "connection_failed";
      return Response.json(
        {
          ...result,
          connected: false,
          error: code,
          ...(await history(false, code)),
        },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    }
  } catch (error) {
    return authErrorResponse(error);
  }
}
