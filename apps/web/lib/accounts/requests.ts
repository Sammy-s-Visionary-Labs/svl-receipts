import { HttpError } from "@/lib/http";
import { readReviewBody } from "@/lib/manager/review-request";

export async function accountBody(request: Request) {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    throw new HttpError(403, "forbidden", "Please submit this form from SVL Receipts.");
  return readReviewBody(request);
}
export function registrationFields(body: Record<string, unknown>) {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (
    fullName.length < 2 ||
    fullName.length > 120 ||
    [...fullName].some((char) => char.charCodeAt(0) < 32) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    phone.length > 40 ||
    (phone && !/^[+\d\s().-]{7,40}$/.test(phone)) ||
    password.length < 12 ||
    password.length > 128
  )
    throw new HttpError(
      400,
      "invalid_request",
      "Enter your name, a valid email, and a password of 12–128 characters. Phone is optional.",
    );
  return { fullName, email, phone, password };
}
