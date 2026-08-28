import { describe, expect, it } from "vitest";
import { identityResultFromResponse } from "./identity-response";

describe("identityResultFromResponse", () => {
  it("keeps inactive accounts distinct from revoked sessions", async () => {
    const inactive = Response.json(
      { error: { code: "account_inactive", message: "Account is not active" } },
      { status: 401 },
    );
    const revoked = Response.json(
      { error: { code: "unauthenticated", message: "Sign in required" } },
      { status: 401 },
    );

    await expect(identityResultFromResponse(inactive)).resolves.toEqual({
      ok: false,
      error: "inactive",
    });
    await expect(identityResultFromResponse(revoked)).resolves.toEqual({
      ok: false,
      error: "revoked",
    });
  });

  it("treats an unparseable 401 as a revoked session", async () => {
    await expect(identityResultFromResponse(new Response("", { status: 401 }))).resolves.toEqual({
      ok: false,
      error: "revoked",
    });
  });

  it("keeps server failures retryable", async () => {
    await expect(identityResultFromResponse(new Response("", { status: 503 }))).resolves.toEqual({
      ok: false,
      error: "network",
    });
  });
});
