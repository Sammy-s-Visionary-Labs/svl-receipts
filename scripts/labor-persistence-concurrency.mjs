/** Concurrent writes on a fresh disposable local labor ledger; never targets a hosted database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const rawUrl = process.env.SVL_APPLIED_DATABASE_URL;
if (!rawUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(rawUrl).hostname)) {
  throw new Error("Labor concurrency verification requires an explicit loopback database");
}
const sql = postgres(rawUrl, { max: 3, prepare: false });
const marker = `labor-cas-${randomUUID()}`;
const manager = randomUUID();
const objects = [randomUUID(), randomUUID()].map((id) => `${id}.bin`);

async function racingWriters(firstWrite, secondWrite) {
  let ready;
  let release = () => {};
  const firstReady = new Promise((resolve) => {
    ready = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    const result = await firstWrite(tx);
    ready({ result });
    await held;
    return result;
  });
  first.catch((error) => ready({ error }));
  try {
    const started = await firstReady;
    if (started.error) throw started.error;
    assert.equal(started.result, 1);
    const second = sql.begin(async (tx) => {
      await tx`select set_config('application_name',${marker},true)`;
      await tx`set local role service_role`;
      return secondWrite(tx);
    });
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        const [row] =
          await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked`;
        if (row.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(blocked, true, "second writer failed to wait for the shared revision lock");
    } finally {
      release();
    }
    assert.equal(await first, 1);
    assert.equal(await second, null, "stale writer overwrote a committed newer revision");
  } finally {
    release();
    await first;
  }
}

async function naturalExpiryDuringSessionLock(objectKey) {
  const token = randomUUID();
  const command = randomUUID();
  let sessionLocked;
  let releaseSession;
  const ready = new Promise((resolve) => {
    sessionLocked = resolve;
  });
  const held = new Promise((resolve) => {
    releaseSession = resolve;
  });
  // Hold the session row as an independent service transaction could. The RPC must
  // check the wall clock after waiting for this row, even though control stayed fixed.
  const blocker = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    await tx`select version from public.labor_worker_sessions where singleton for update`;
    sessionLocked();
    await held;
  });
  try {
    await ready;
    await sql`update public.labor_state set control=control || ${sql.json({
      sync: { status: "running", commandId: command },
      workerLease: {
        leaseToken: token,
        commandId: command,
        expiresAt: new Date(Date.now() + 500).toISOString(),
      },
    })} where singleton`;
    const stale = sql.begin(async (tx) => {
      await tx`select set_config('application_name',${marker},true)`;
      await tx`set local role service_role`;
      const [row] =
        await tx`select public.compare_and_swap_labor_worker_session(1,${objectKey},${"c".repeat(64)},${token}) as result`;
      return row.result;
    });
    let blockedAndExpired = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] =
        await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked,
        (control#>>'{workerLease,expiresAt}')::timestamptz<=clock_timestamp() as expired from public.labor_state where singleton`;
      if (row.blocked && row.expired) {
        blockedAndExpired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseSession();
    await blocker;
    assert.equal(
      blockedAndExpired,
      true,
      "session lease did not expire while the pointer row was locked",
    );
    assert.equal(await stale, null, "lease expiry was checked before waiting for the session row");
    const [retained] = await sql`select version from public.labor_worker_sessions where singleton`;
    assert.equal(Number(retained.version), 1);
  } finally {
    releaseSession();
    await blocker;
  }
}

async function naturalExpiryDuringImportLock() {
  const leaseToken = randomUUID();
  const commandId = randomUUID();
  const period = { from: "2026-09-24", to: "2026-09-30" };
  await sql`update public.labor_state set control=control || ${sql.json({
    sync: { status: "running", commandId },
    workerLease: {
      leaseToken,
      commandId,
      period,
      expiresAt: new Date(Date.now() + 500).toISOString(),
      imported: false,
    },
  })} where singleton`;
  const [before] = await sql`select revision,control from public.labor_state where singleton`;
  const [audit] = await sql`select count(*)::int as count from public.labor_control_events`;
  const source = {
    id: randomUUID(),
    kind: "timesheet",
    position: 0,
    file_sha256: "d".repeat(64),
    content_hash: "d".repeat(64),
    summary: { filename: "TEST-expired-import.xlsx" },
    report: { entries: [] },
  };
  const manifest = [
    {
      id: source.id,
      kind: source.kind,
      position: source.position,
      content_hash: source.content_hash,
    },
  ];
  const proposed = {
    ...before.control,
    workerLease: { ...before.control.workerLease, imported: true },
  };
  let ledgerLocked;
  let releaseLedger;
  const ready = new Promise((resolve) => {
    ledgerLocked = resolve;
  });
  const held = new Promise((resolve) => {
    releaseLedger = resolve;
  });
  const blocker = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    await tx`select revision from public.labor_state where singleton for update`;
    ledgerLocked();
    await held;
  });
  try {
    await ready;
    const stale = sql.begin(async (tx) => {
      await tx`select set_config('application_name',${marker},true)`;
      await tx`set local role service_role`;
      const [row] =
        await tx`select public.compare_and_swap_labor_state_leased(${before.revision},${tx.json(proposed)},${tx.json(manifest)},${tx.json([source])},${leaseToken},${commandId},${period.from},${period.to}) as result`;
      return row.result;
    });
    let blockedAndExpired = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] =
        await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked,
        (control#>>'{workerLease,expiresAt}')::timestamptz<=clock_timestamp() as expired from public.labor_state where singleton`;
      if (row.blocked && row.expired) {
        blockedAndExpired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseLedger();
    await blocker;
    assert.equal(
      blockedAndExpired,
      true,
      "import lease did not expire while the ledger row was locked",
    );
    assert.equal(await stale, null, "expired worker import committed after a ledger lock wait");
    const [after] = await sql`select revision,control from public.labor_state where singleton`;
    assert.equal(Number(after.revision), Number(before.revision));
    assert.equal(after.control.workerLease.imported, false);
    const [sources] =
      await sql`select count(*)::int as count from public.labor_source_imports where id=${source.id}`;
    const [events] = await sql`select count(*)::int as count from public.labor_control_events`;
    assert.equal(sources.count, 0);
    assert.equal(events.count, audit.count);
  } finally {
    releaseLedger();
    await blocker;
  }
}

async function revokeManagerDuringLedgerLock(demote) {
  const [before] = await sql`select revision,control from public.labor_state where singleton`;
  const [audit] = await sql`select count(*)::int as count from public.labor_control_events`;
  let locked;
  let release = () => {};
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const blocker = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    await tx`select revision from public.labor_state where singleton for update`;
    locked();
    await held;
  });
  try {
    await ready;
    const pending = sql
      .begin(async (tx) => {
        await tx`select set_config('application_name',${marker},true)`;
        await tx`set local role service_role`;
        return tx`select public.compare_and_swap_labor_state(${before.revision},${tx.json({ ...before.control, rulesRevision: 999 })},'[]','[]',${manager}) as result`;
      })
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    let blocked = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] =
        await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked`;
      if (row.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(blocked, true, "manager write did not wait for ledger lock");
    if (demote) await sql`update public.profiles set role='worker' where id=${manager}`;
    else await sql`update public.profiles set disabled=true where id=${manager}`;
    release();
    await blocker;
    const result = await pending;
    assert.equal(
      result.error?.message,
      demote ? "forbidden" : "unauthenticated",
      "manager permission was not rechecked after the ledger lock wait",
    );
    const [after] = await sql`select revision,control from public.labor_state where singleton`;
    const [events] = await sql`select count(*)::int as count from public.labor_control_events`;
    assert.deepEqual(after, before, "revoked manager changed the labor ledger");
    assert.equal(events.count, audit.count, "revoked manager appended audit evidence");
  } finally {
    release();
    await blocker;
    await sql`update public.profiles set disabled=false,role='manager' where id=${manager}`;
  }
}

try {
  const [state] = await sql`select revision,control from public.labor_state where singleton`;
  const [session] =
    await sql`select version,object_key from public.labor_worker_sessions where singleton`;
  if (state.revision !== "0" && state.revision !== 0)
    throw new Error("Requires a fresh disposable labor ledger");
  if (state.control !== null || session.object_key !== null)
    throw new Error("Refusing to change an existing labor ledger or worker session");
  await sql`insert into auth.users(id,aud,role,email,raw_app_meta_data) values(${manager},'authenticated','authenticated',${`${marker}@example.invalid`},'{"svl_access_approved":true}')`;
  await sql`update public.profiles set role='manager' where id=${manager}`;
  await racingWriters(
    async (tx) => {
      const [row] =
        await tx`select public.compare_and_swap_labor_state(0,${tx.json({ version: 1, marker, winningWriter: 1, sync: { command: "connect" }, workerLease: null })},'[]','[]',${manager}) as result`;
      return Number(row.result);
    },
    async (tx) => {
      const [row] =
        await tx`select public.compare_and_swap_labor_state(0,${tx.json({ version: 1, marker, winningWriter: 2 })},'[]','[]',${manager}) as result`;
      return row.result;
    },
  );
  const [winner] = await sql`select revision,control from public.labor_state where singleton`;
  assert.equal(Number(winner.revision), 1);
  assert.equal(winner.control.winningWriter, 1);
  const [events] =
    await sql`select count(*)::int as count from public.labor_control_events where details->'resultingControl'->>'marker'=${marker}`;
  assert.equal(events.count, 1, "stale writer inserted a second audit record");
  await revokeManagerDuringLedgerLock(false);
  await revokeManagerDuringLedgerLock(true);

  await sql`insert into storage.objects(bucket_id,name,metadata) values('labor-worker-sessions',${objects[0]},${sql.json({ size: 1 })}),('labor-worker-sessions',${objects[1]},${sql.json({ size: 1 })})`;
  await racingWriters(
    async (tx) => {
      const [row] =
        await tx`select public.compare_and_swap_labor_worker_session(0,${objects[0]},${"a".repeat(64)},null) as result`;
      return Number(row.result);
    },
    async (tx) => {
      const [row] =
        await tx`select public.compare_and_swap_labor_worker_session(0,${objects[1]},${"b".repeat(64)},null) as result`;
      return row.result;
    },
  );
  const [currentSession] =
    await sql`select version,object_key from public.labor_worker_sessions where singleton`;
  assert.equal(Number(currentSession.version), 1);
  assert.equal(currentSession.object_key, objects[0]);

  // Simulate a worker's app check passing just before a control transaction expires its lease.
  const leaseToken = randomUUID();
  const commandId = randomUUID();
  await sql`update public.labor_state set control=control || ${sql.json({
    sync: { status: "running", commandId },
    workerLease: { leaseToken, commandId, expiresAt: new Date(Date.now() + 60000).toISOString() },
  })} where singleton`;
  let locked;
  let releaseExpiry;
  const expiryLocked = new Promise((resolve) => {
    locked = resolve;
  });
  const expiryHeld = new Promise((resolve) => {
    releaseExpiry = resolve;
  });
  const expiry = sql.begin(async (tx) => {
    await tx`set local role service_role`;
    await tx`update public.labor_state set control=jsonb_set(control,'{workerLease,expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) where singleton`;
    locked();
    await expiryHeld;
  });
  try {
    await expiryLocked;
    const staleSession = sql.begin(async (tx) => {
      await tx`select set_config('application_name',${marker},true)`;
      await tx`set local role service_role`;
      const [row] =
        await tx`select public.compare_and_swap_labor_worker_session(1,${objects[1]},${"b".repeat(64)},${leaseToken}) as result`;
      return row.result;
    });
    let blocked = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] =
        await sql`select exists(select 1 from pg_stat_activity where application_name=${marker} and wait_event_type='Lock') as blocked`;
      if (row.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseExpiry();
    await expiry;
    assert.equal(blocked, true, "session pointer write did not wait for the labor control lock");
    assert.equal(await staleSession, null, "expired lease committed after a control transaction");
    const [retained] =
      await sql`select version,object_key from public.labor_worker_sessions where singleton`;
    assert.equal(Number(retained.version), 1);
    assert.equal(retained.object_key, objects[0]);
  } finally {
    releaseExpiry();
    await expiry;
  }
  await naturalExpiryDuringSessionLock(objects[1]);
  await naturalExpiryDuringImportLock();
  console.log(
    "Ledger/session races retained one revision; revoked managers and expired workers waiting on row locks changed nothing.",
  );
} finally {
  // This test leaves only its synthetic facts in the disposable database; stop that QA project after use.
  // Audits intentionally cannot be deleted just to clean up a concurrency test.
  await sql.end({ timeout: 5 });
}
