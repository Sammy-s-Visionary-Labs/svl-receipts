import { createHmac } from "node:crypto";
import { accountBody, registrationFields } from "@/lib/accounts/requests";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function POST(request: Request) {
  try {
    const fields = registrationFields(await accountBody(request));
    const db = createServiceRoleClient();
    const ip =
      request.headers.get("x-vercel-forwarded-for") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("registration_unavailable");
    for (const [key, limit] of [
      [`ip:${ip}`, 5],
      [`email:${fields.email}`, 3],
    ] as const) {
      const bucket = createHmac("sha256", secret).update(key).digest("hex");
      const { data, error } = await db.rpc("consume_access_request_limit", {
        p_bucket: bucket,
        p_limit: limit,
      });
      if (error) throw new Error("registration_unavailable");
      if (data !== true)
        throw new HttpError(
          429,
          "rate_limited",
          "Too many requests. Please try again in an hour or contact your manager.",
        );
    }
    // Supabase hashes the password. The DB trigger atomically creates a disabled, pending worker.
    // Approval is an in-person manager identity check; this flow does not send confirmation emails.
    const { error } = await db.auth.admin.createUser({
      email: fields.email,
      password: fields.password,
      email_confirm: true,
      user_metadata: { full_name: fields.fullName, phone: fields.phone },
    });
    if (error && !["email_exists", "user_already_exists"].includes(error.code ?? "")) {
      if (error.code === "weak_password")
        throw new HttpError(
          400,
          "weak_password",
          "Choose a stronger password with at least 12 characters.",
        );
      throw new Error("registration_unavailable");
    }
    // Do not reveal whether an email already belongs to an account, or overwrite its credentials.
    return Response.json(
      {
        message:
          "If this email is new, your access request has been sent to the manager. If you already have an account, use your existing password to sign in.",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError
      ? httpErrorResponse(error)
      : Response.json(
          { error: { message: "Account requests are temporarily unavailable. Please try again." } },
          { status: 503 },
        );
  }
}
