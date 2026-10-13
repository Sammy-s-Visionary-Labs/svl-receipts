import { requireLaborWorker } from "@/lib/labor/access";
import { laborError, laborResponse } from "@/lib/labor/http";
import {
  getSupabaseLaborEncryptedWorkerSession,
  putSupabaseLaborEncryptedWorkerSession,
} from "@/lib/labor/persistence";
import {
  assertLaborWorkerLease,
  beginLaborWorkerConnection,
  markLaborWorkerConnected,
} from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("SVLSESSION1\n");

export async function GET(request: Request) {
  try {
    requireLaborWorker(request);
    const item = await getSupabaseLaborEncryptedWorkerSession();
    if (!item)
      return laborResponse(
        { error: { code: "not_connected", message: "Supercrew session is not connected" } },
        404,
      );
    return new Response(Buffer.from(item.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
        "Content-Length": String(item.bytes.byteLength),
        "x-labor-session-version": String(item.version),
        ETag: `"${item.version}"`,
      },
    });
  } catch (error) {
    return laborError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireLaborWorker(request);
    if (
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/octet-stream"
    )
      throw new Error("Encrypted worker session requires a binary body");
    const versionText = request.headers.get("x-labor-session-version");
    if (!versionText || !/^\d+$/.test(versionText) || !Number.isSafeInteger(Number(versionText)))
      throw new Error("Worker session version is required");
    const leaseToken = request.headers.get("x-labor-lease-token");
    if (leaseToken) await assertLaborWorkerLease(leaseToken);
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
      throw new Error("Encrypted worker session is too large");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Encrypted worker session is required");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Encrypted worker session is too large");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length <= MAGIC.length + 28 || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Unsupported encrypted worker session envelope");
    if (leaseToken) await assertLaborWorkerLease(leaseToken);
    else await beginLaborWorkerConnection();
    const version = await putSupabaseLaborEncryptedWorkerSession(
      bytes,
      Number(versionText),
      leaseToken,
    );
    if (version === null)
      throw new Error("Stale worker session version; reconnect or reload the session");
    if (leaseToken) await assertLaborWorkerLease(leaseToken);
    else await markLaborWorkerConnected();
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        "x-labor-session-version": String(version),
        ETag: `"${version}"`,
      },
    });
  } catch (error) {
    return laborError(error);
  }
}
