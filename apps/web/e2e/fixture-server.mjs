import { createServer } from "node:http";
import { fixtureUser, profileFromAuthorization } from "./fixture-auth.mjs";

const port = Number(process.env.RA27_E2E_AUTH_PORT ?? 54877);

// Real application auth guards call this local HTTP service. No application auth
// branch, production test flag, provider credential, or remote data is involved.
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, apikey, content-type, x-client-info",
  );
  const send = (status, body) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  if (request.method === "OPTIONS") return send(204, null);
  if (url.pathname === "/health") return send(200, { fixture: "ra27", ok: true });
  const profile = profileFromAuthorization(request.headers.authorization);
  if (!profile) return send(401, { code: "bad_jwt", message: "Fixture sign in required" });

  if (url.pathname === "/auth/v1/user") return send(200, fixtureUser(profile.id));
  if (url.pathname === "/rest/v1/profiles") {
    const selectedId = url.searchParams.get("id");
    if (selectedId && selectedId !== `eq.${profile.id}`) return send(200, null);
    return send(200, profile);
  }
  if (url.pathname === "/rest/v1/receipt_categories" && request.method === "GET") {
    if (profile.disabled || !["manager", "admin"].includes(profile.role)) {
      return send(403, { code: "42501", message: "Fixture manager role required" });
    }
    // Production starts with no approved categories; use the real read route in Settings tests.
    return send(200, []);
  }
  if (url.pathname === "/rest/v1/rpc/manager_review_queue") {
    if (profile.disabled || !["manager", "admin"].includes(profile.role)) {
      return send(403, { code: "42501", message: "Fixture manager role required" });
    }
    return send(200, []);
  }
  return send(404, { code: "fixture_route_missing", message: `No fixture for ${url.pathname}` });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`RA-27 synthetic auth fixture listening on 127.0.0.1:${port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
