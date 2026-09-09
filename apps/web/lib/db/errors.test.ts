import { describe, expect, it } from "vitest";
import { httpErrorResponse } from "@/lib/http";
import { rpcHttpError } from "./errors";

describe("database error responses", () => {
  it("turns the job-availability SQL exception into an actionable safe 400 response", async () => {
    const response = httpErrorResponse(
      rpcHttpError({ message: "invalid_request_job_unavailable" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message:
          "The selected Housecall job is unavailable. Refresh jobs and choose another destination.",
      },
    });
  });

  it.each([
    { message: "unauthenticated", status: 401, code: "unauthenticated", text: "Sign in required" },
    { message: "forbidden", status: 403, code: "forbidden", text: "Receipt access denied" },
    {
      message: "invalid_request_private_database_detail",
      status: 400,
      code: "invalid_request",
      text: "Invalid request",
    },
    {
      message: "conflict private_database_detail",
      status: 409,
      code: "conflict",
      text: "Request could not be applied",
    },
    { message: "private_database_detail", status: 500, code: "internal", text: "Request failed" },
  ])("preserves the existing safe mapping for $code", ({ message, status, code, text }) => {
    const error = rpcHttpError({ message });
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe(text);
    expect(error.message).not.toContain("private_database_detail");
  });
});
