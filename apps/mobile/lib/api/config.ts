type ApiBaseUrlInput = {
  envUrl?: string;
  hostUri?: string | null;
  platform?: string;
  isDevice?: boolean;
};

const LOOPBACK_URL_PATTERN = /^(https?:\/\/)(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

export function resolveApiBaseUrl(input: ApiBaseUrlInput): string {
  const env = input.envUrl?.trim().replace(/\/$/, "");
  if (env) {
    const usesLoopback = LOOPBACK_URL_PATTERN.test(env);
    if (!usesLoopback) {
      return env;
    }
    if (input.platform === "android" && input.isDevice === false) {
      return env.replace(LOOPBACK_URL_PATTERN, "$1" + "10.0.2.2");
    }
    if (input.isDevice !== true) {
      return env;
    }
  }
  const host = input.hostUri?.split(":")[0]?.trim();
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:3000`;
  }
  if (input.isDevice === true) {
    throw new Error("physical_device_api_url_required");
  }
  if (input.platform === "android" && input.isDevice === false) {
    return "http://10.0.2.2:3000";
  }
  return "http://localhost:3000";
}
