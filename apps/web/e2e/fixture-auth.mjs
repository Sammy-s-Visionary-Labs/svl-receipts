import { createHmac, timingSafeEqual } from "node:crypto";

// These identities and the signing string belong only to the loopback test service.
const signingString = "ra27-local-fixture-signature-never-a-production-credential";
export const FIXTURE_USERS = {
  manager: { id: "a2700000-0000-4000-8000-000000000001", role: "manager", disabled: false },
  admin: { id: "a2700000-0000-4000-8000-000000000002", role: "admin", disabled: false },
  worker: { id: "a2700000-0000-4000-8000-000000000003", role: "worker", disabled: false },
  disabled: { id: "a2700000-0000-4000-8000-000000000004", role: "manager", disabled: true },
};

/** @param {keyof typeof FIXTURE_USERS} identity */
export function fixtureSession(identity) {
  const profile = FIXTURE_USERS[identity];
  const now = Math.floor(Date.now() / 1000);
  const user = fixtureUser(profile.id);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: profile.id,
      aud: "authenticated",
      role: "authenticated",
      iat: now,
      exp: now + 86_400,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", signingString).update(input).digest("base64url");
  return {
    access_token: `${input}.${signature}`,
    refresh_token: `fixture-refresh-${profile.id}`,
    token_type: "bearer",
    expires_in: 86_400,
    expires_at: now + 86_400,
    user,
  };
}

/** @param {string} id */
export function fixtureUser(id) {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: `fixture-${id.slice(-4)}@example.invalid`,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** @param {string | undefined} authorization */
export function profileFromAuthorization(authorization) {
  try {
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = token.split(".");
    const expected = createHmac("sha256", signingString).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature ?? "", "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.exp <= Date.now() / 1000) return null;
    return Object.values(FIXTURE_USERS).find((profile) => profile.id === claims.sub) ?? null;
  } catch {
    return null;
  }
}

/** @param {keyof typeof FIXTURE_USERS} identity */
export function fixtureCookie(identity) {
  return {
    name: "sb-127-auth-token",
    value: `base64-${Buffer.from(JSON.stringify(fixtureSession(identity))).toString("base64url")}`,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: /** @type {const} */ ("Lax"),
  };
}
