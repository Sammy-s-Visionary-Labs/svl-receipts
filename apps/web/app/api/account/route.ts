import { createServerSupabaseClient } from "@/lib/supabase/server";
export async function GET() {
  const db = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user)
    return Response.json({ error: { message: "Sign in required" } }, { status: 401 });
  const { data, error: profileError } = await db
    .from("profiles")
    .select("role,disabled,access_status")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError || !data)
    return Response.json({ error: { message: "Could not check account access" } }, { status: 503 });
  return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
