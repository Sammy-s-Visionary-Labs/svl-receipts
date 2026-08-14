import { timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/http";

export function requireCronSecret(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpError(500, "internal", "Request failed");
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthenticated", "Sign in required");
  }

  const token = header.slice("Bearer ".length);
  const left = Buffer.from(token);
  const right = Buffer.from(secret);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new HttpError(401, "unauthenticated", "Sign in required");
  }
}
