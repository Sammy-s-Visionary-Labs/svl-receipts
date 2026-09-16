import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

// Intentionally restricted to a disposable local Supabase stack, never hosted business data.
const env = JSON.parse(await readFile(process.env.SVL_LOCAL_AUTH_CONFIG, "utf8"));
assert.equal(new URL(env.API_URL).hostname, "127.0.0.1");
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.API_URL, env.SERVICE_ROLE_KEY, options);
const ids = [];
const suffix = randomUUID();
const password = `Local-test-${randomUUID()}`;
async function create(kind, approved) {
  const email = `${kind}-${suffix}@example.invalid`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ...(approved ? { app_metadata: { svl_access_approved: true } } : {}),
    user_metadata: { full_name: `Synthetic ${kind}`, role: "admin", svl_access_approved: true },
  });
  assert.ifError(error);
  ids.push(data.user.id);
  if (approved)
    assert.ifError(
      (
        await service
          .from("profiles")
          .update({ role: kind, access_status: "approved", disabled: false })
          .eq("id", data.user.id)
      ).error,
    );
  const client = createClient(env.API_URL, env.ANON_KEY, options);
  assert.ifError((await client.auth.signInWithPassword({ email, password })).error);
  return { id: data.user.id, client };
}
async function active(client) {
  const r = await client.rpc("caller_is_active");
  assert.ifError(r.error);
  return r.data;
}
async function action(actor, target, action, version, role = null) {
  const r = await actor.client.rpc("manage_workspace_user", {
    p_target_id: target.id,
    p_action: action,
    p_expected_version: version,
    p_role: role,
  });
  assert.ifError(r.error);
}
try {
  const admin = await create("admin", true);
  const manager = await create("manager", true);
  const worker = await create("worker", false);
  const pending = await worker.client
    .from("profiles")
    .select("role,disabled,access_status")
    .eq("id", worker.id)
    .single();
  assert.deepEqual(pending.data, { role: "worker", disabled: true, access_status: "pending" });
  assert.equal(await active(worker.client), false);
  await action(manager, worker, "approve", 0);
  assert.equal(await active(worker.client), true);
  await action(manager, worker, "disable", 1);
  assert.equal(await active(worker.client), false);
  await action(manager, worker, "enable", 2);
  await action(admin, worker, "role", 3, "manager");
  assert.equal((await worker.client.rpc("current_user_role")).data, "manager");
  const blocked = await manager.client.rpc("manage_workspace_user", {
    p_target_id: worker.id,
    p_action: "role",
    p_expected_version: 4,
    p_role: "admin",
  });
  assert.equal(blocked.error?.code, "42501");
  const authUser = await service.auth.admin.getUserById(worker.id);
  assert.equal(authUser.data.user.id, worker.id);
  console.log(
    "PASS: real local Supabase Auth signup/password sign-in, atomic pending profile, approval, immediate disable with old JWT, re-enable, admin role change, and manager escalation denial.",
  );
} finally {
  for (const id of ids.reverse()) assert.ifError((await service.auth.admin.deleteUser(id)).error);
}
