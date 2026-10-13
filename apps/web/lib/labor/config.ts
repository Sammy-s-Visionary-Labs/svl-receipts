export function laborDevelopmentEnabled(env = process.env): boolean {
  return env.NODE_ENV === "development" && env.LABOR_DEVELOPMENT_ENABLED === "1";
}

export function laborFeatureEnabled(env = process.env): boolean {
  return env.LABOR_ENABLED === "1" || laborDevelopmentEnabled(env);
}

export function laborUsesSupabase(env = process.env): boolean {
  // Production never falls back to a filesystem inside an ephemeral deployment.
  return env.NODE_ENV === "production" || env.LABOR_PERSISTENCE === "supabase";
}

export function laborLocalPreviewEnabled(env = process.env): boolean {
  return laborDevelopmentEnabled(env) && env.LABOR_LOCAL_PREVIEW === "1" && !laborUsesSupabase(env);
}

export function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());
}

export function localDevelopmentDatabaseAllowed(env = process.env): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!laborDevelopmentEnabled(env) || !url) return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
