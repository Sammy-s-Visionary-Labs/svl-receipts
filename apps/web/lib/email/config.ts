import { timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/http";
import { UUID } from "@/lib/manager/review-request";
export const EMAIL_MAILBOX = "recisvl@gmail.com";
export const EMAIL_BUCKET = "receipt-emails";
export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;
export function emailConfig() {
  const secret = process.env.EMAIL_IMPORT_SECRET?.trim();
  const ownerId = process.env.EMAIL_IMPORT_OWNER_ID?.trim();
  if (!secret || secret.length < 32 || !ownerId || !UUID.test(ownerId))
    throw new HttpError(503, "email_not_configured", "Email receipt intake is not configured.");
  return { secret, ownerId };
}
export function requireEmailImporter(request: Request) {
  const config = emailConfig();
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token),
    b = Buffer.from(config.secret);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpError(401, "unauthenticated", "Email importer authentication required.");
  return config;
}
export async function readSmallJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request", "Missing request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new HttpError(413, "invalid_request", "Request is too large.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON.");
  }
}
