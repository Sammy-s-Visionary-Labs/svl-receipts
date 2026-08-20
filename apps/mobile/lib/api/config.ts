export function resolveApiBaseUrl(input: { envUrl?: string; hostUri?: string | null }): string {
  const env = input.envUrl?.trim().replace(/\/$/, "");
  if (env) {
    return env;
  }
  const host = input.hostUri?.split(":")[0]?.trim();
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:3000`;
  }
  return "http://localhost:3000";
}
