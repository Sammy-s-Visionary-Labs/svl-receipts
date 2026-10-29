import { requireLaborAccess } from "@/lib/labor/access";
import { laborError, laborResponse } from "@/lib/labor/http";
import { originalLaborDownload } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireLaborAccess(request);
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/.test(id))
      return laborResponse({ error: { message: "Import not found" } }, 404);
    const result = await originalLaborDownload(id);
    if (!result) return laborResponse({ error: { message: "Import not found" } }, 404);
    if ("url" in result)
      return new Response(null, {
        status: 302,
        headers: { Location: result.url, "Cache-Control": "private, no-store" },
      });
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return laborError(error);
  }
}
