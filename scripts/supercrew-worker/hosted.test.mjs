import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NeedsLoginError } from "./browser.mjs";
import { workerAppUrl, workerConfig } from "./core.mjs";
import {
  bootstrapSession,
  getSession,
  loadClaim,
  preflight,
  runLeasedImport,
  safeWorkerError,
  saveClaim,
  validateClaim,
  workflowRunId,
} from "./hosted.mjs";
import { decryptSession, encryptSession, MAX_SESSION_BYTES } from "./session.mjs";

const state = {
  cookies: [
    {
      name: "fixture",
      value: "SYNTHETIC",
      domain: "app.supercrew.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    {
      origin: "https://app.supercrew.com",
      localStorage: [{ name: "fixture", value: "SYNTHETIC" }],
      indexedDB: [],
    },
  ],
};
const lease = {
  commandId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  leaseToken: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  period: { from: "2020-01-01", to: "2020-01-14" },
  sync: { timeZone: "America/New_York" },
};
const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 42]);

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "svl-hosted-worker-"));
  const config = workerConfig(
    {
      LABOR_WORKER_TOKEN: "SYNTHETIC-PRIVATE-WORKER-TOKEN-123456789",
      LABOR_APP_URL: "https://fixture.example",
      LABOR_APP_HOST: "fixture.example",
      LABOR_SESSION_ENCRYPTION_KEY: "a1".repeat(32),
      SUPERCREW_REPORT_DOWNLOADS_APPROVED: "1",
    },
    directory,
  );
  const events = [];
  const finishes = [];
  let heartbeats = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.get("Authorization"), `Bearer ${config.token}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const path = new URL(url).pathname;
    if (path.endsWith("/claim")) {
      events.push("claim");
      return Response.json({ claim: options.noClaim ? null : lease });
    }
    if (path.endsWith("/heartbeat")) {
      events.push("heartbeat");
      heartbeats++;
      assert.equal(JSON.parse(init.body).leaseToken, lease.leaseToken);
      return options.loseLease && heartbeats > 1
        ? Response.json({ error: { message: "Stale worker lease" } }, { status: 409 })
        : Response.json({ ok: true });
    }
    if (path.endsWith("/session") && init.method === "GET") {
      events.push("session:get");
      if (options.missingSession) return new Response(null, { status: 404 });
      return new Response(
        encryptSession(state, options.wrongKey ? "b2".repeat(32) : config.sessionEncryptionKey),
        { headers: { "x-labor-session-version": "2" } },
      );
    }
    if (path.endsWith("/session") && init.method === "PUT") {
      events.push("session:put");
      if (!options.bootstrap)
        assert.equal(init.headers.get("x-labor-lease-token"), lease.leaseToken);
      assert.equal(init.headers.get("x-labor-session-version"), options.missingSession ? "0" : "2");
      assert.deepEqual(decryptSession(init.body, config.sessionEncryptionKey), state);
      return new Response(null, {
        status: options.saveFailure ? 503 : 204,
        headers: { "x-labor-session-version": "3" },
      });
    }
    if (path.endsWith("/import")) {
      events.push("import");
      assert.equal(init.body.get("commandId"), lease.commandId);
      assert.equal(init.body.get("leaseToken"), lease.leaseToken);
      assert.equal(init.body.get("periodStart"), lease.period.from);
      assert.equal(init.body.get("periodEnd"), lease.period.to);
      assert.equal(init.body.get("notesScope"), "daily_timesheet");
      assert.deepEqual(Buffer.from(await init.body.get("file").arrayBuffer()), bytes);
      assert.deepEqual(Buffer.from(await init.body.get("notesFile").arrayBuffer()), bytes);
      return Response.json({ duplicate: false });
    }
    if (path.endsWith("/finish")) {
      const finish = JSON.parse(init.body);
      finishes.push(finish);
      events.push(`finish:${finish.status}`);
      assert.equal(finish.leaseToken, lease.leaseToken);
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected fixture API path");
  };
  const resources = {
    page: { goto: async () => events.push("navigate") },
    context: {
      storageState: async (options) => {
        assert.equal(options.indexedDB, true);
        events.push("capture");
        return state;
      },
      close: async () => events.push("context:closed"),
    },
    browser: { close: async () => events.push("browser:closed") },
  };
  return {
    config,
    events,
    finishes,
    resources,
    operations: {
      fetch: fetchImpl,
      createBrowser: async (_config, actual) => {
        assert.deepEqual(actual, state);
        events.push("browser");
        return resources;
      },
      verify: async () => {
        events.push("company:verified");
        if (options.loginExpired) throw new NeedsLoginError("SYNTHETIC login expired");
      },
      acquire: async (_config, interval) => {
        assert.deepEqual(interval, { start: lease.period.from, end: lease.period.to });
        events.push("download:pair");
        if (options.slowSource) await new Promise((resolve) => setTimeout(resolve, 60));
        return { bytes, notesBytes: bytes };
      },
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("hosted origins require an exact HTTPS allowlist while existing loopback remains available", () => {
  assert.equal(
    workerAppUrl("https://fixture.example", "fixture.example"),
    "https://fixture.example",
  );
  assert.equal(workerAppUrl("http://127.0.0.1:3145"), "http://127.0.0.1:3145");
  for (const url of [
    "http://fixture.example",
    "https://fixture.example.evil",
    "https://user:password@fixture.example",
    "https://fixture.example/api",
    "https://fixture.example?token=secret",
    "https://fixture.example:444",
  ])
    assert.throws(() => workerAppUrl(url, "fixture.example"));
  assert.throws(() => workerAppUrl("https://fixture.example"));
});

test("preflight only calls claim and does no session/browser work when nothing is due", async () => {
  const f = await fixture({ noClaim: true });
  try {
    assert.equal(await preflight(f.config, "github:123:1", f.operations.fetch), null);
    assert.deepEqual(f.events, ["claim"]);
  } finally {
    await f.cleanup();
  }
});

test("claim records are private and cannot be reused by another GitHub attempt", async () => {
  const f = await fixture();
  try {
    await saveClaim(f.config, "github:123:1", lease);
    assert.equal((await stat(join(f.config.stateDir, "hosted-claim.json"))).mode & 0o777, 0o600);
    assert.deepEqual(
      await loadClaim(f.config, { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" }),
      lease,
    );
    await assert.rejects(
      loadClaim(f.config, { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }),
      /different worker run/,
    );
    assert.equal(
      (await readFile(join(f.config.stateDir, "hosted-claim.json"), "utf8")).includes(
        lease.leaseToken,
      ),
      true,
    );
    assert.equal(workflowRunId({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }), "github:123:2");
    assert.throws(() => workflowRunId({ LABOR_RUN_ID: "bad\nidentifier" }));
    assert.throws(
      () =>
        validateClaim(
          { ...lease, period: { from: "2026-10-01", to: "2026-10-13" } },
          new Date("2026-10-13T12:00:00Z"),
        ),
      /completed dates/,
    );
  } finally {
    await f.cleanup();
  }
});

test("finite import verifies source, uploads both originals under its lease and refreshes session before finish", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await runLeasedImport(f.config, lease, f.operations), { duplicate: false });
    assert.deepEqual(f.events, [
      "heartbeat",
      "session:get",
      "browser",
      "navigate",
      "company:verified",
      "download:pair",
      "import",
      "capture",
      "session:put",
      "finish:idle",
      "context:closed",
      "browser:closed",
    ]);
    assert.equal(f.finishes.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("missing and expired source login require reconnection without exporting or overwriting session", async () => {
  for (const options of [{ missingSession: true }, { loginExpired: true }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(runLeasedImport(f.config, lease, f.operations));
      assert.equal(f.events.includes("import"), false);
      assert.equal(f.events.includes("session:put"), false);
      assert.equal(f.finishes[0].status, "needs_login");
    } finally {
      await f.cleanup();
    }
  }
});

test("wrong session key fails before opening source and never publishes replacement state", async () => {
  const f = await fixture({ wrongKey: true });
  try {
    await assert.rejects(runLeasedImport(f.config, lease, f.operations), /authentication failed/);
    assert.equal(f.events.includes("browser"), false);
    assert.equal(f.events.includes("session:put"), false);
    assert.equal(f.finishes[0].status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("post-import session failure keeps import success explicit for safe recovery", async () => {
  const f = await fixture({ saveFailure: true });
  try {
    await assert.rejects(
      runLeasedImport(f.config, lease, f.operations),
      /Reports were imported; review import history/,
    );
    assert.equal(f.events.filter((event) => event === "import").length, 1);
    assert.equal(f.finishes[0].status, "failed");
    assert.match(f.finishes[0].lastError, /Reports were imported/);
  } finally {
    await f.cleanup();
  }
});

test("lease loss and finite deadline stop further import/session writes and close the browser", async () => {
  for (const options of [{ loseLease: true, heartbeatEveryMs: 5 }, { deadlineMs: 5 }]) {
    const f = await fixture({ ...options, slowSource: true });
    try {
      await assert.rejects(
        runLeasedImport(f.config, lease, {
          ...f.operations,
          heartbeatEveryMs: options.heartbeatEveryMs,
          deadlineMs: options.deadlineMs,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(f.events.includes("import"), false);
      assert.equal(f.events.includes("session:put"), false);
      assert.equal(f.events.includes("browser:closed"), true);
      assert.equal(f.finishes[0].status, "failed");
    } finally {
      await f.cleanup();
    }
  }
});

test("unbounded streamed session bodies and sensitive error values are rejected safely", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      getSession(
        f.config,
        async () =>
          new Response(Buffer.alloc(MAX_SESSION_BYTES + 1), {
            headers: { "x-labor-session-version": "1" },
          }),
      ),
      /storage limit/,
    );
    const redacted = safeWorkerError(
      new Error(
        `${f.config.token} ${f.config.sessionEncryptionKey} ${lease.leaseToken} https://private.example?secret=hidden`,
      ),
      f.config,
      lease,
    );
    for (const secret of [
      f.config.token,
      f.config.sessionEncryptionKey,
      lease.leaseToken,
      "secret=hidden",
    ])
      assert.equal(redacted.includes(secret), false);
  } finally {
    await f.cleanup();
  }
});

test("invalid session metadata cancels the response before reading authentication bytes", async () => {
  const f = await fixture();
  try {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      getSession(f.config, async () => new Response(body)),
      /invalid version/,
    );
    assert.equal(cancelled, true);
  } finally {
    await f.cleanup();
  }
});

test("bootstrap publishes only after portable fresh-context company verification and never exports", async () => {
  for (const accepted of [true, false]) {
    const f = await fixture({ bootstrap: true });
    try {
      const operations = {
        ...f.operations,
        createLocalBrowser: async () => f.resources,
        createPortableBrowser: async (_config, actual) => {
          assert.deepEqual(actual, state);
          f.events.push("fresh:browser");
          return f.resources;
        },
        connect: async () => f.events.push("human:connected"),
        verify: async () => {
          f.events.push("fresh:verified");
          if (!accepted) throw new NeedsLoginError("SYNTHETIC wrong source company");
        },
      };
      if (accepted) await bootstrapSession(f.config, operations);
      else await assert.rejects(bootstrapSession(f.config, operations), /wrong source company/);
      assert.equal(f.events.includes("session:put"), accepted);
      assert.equal(f.events.includes("import"), false);
      assert.equal(f.events.includes("download:pair"), false);
      assert.equal(f.events.indexOf("session:put") > f.events.indexOf("fresh:verified"), accepted);
    } finally {
      await f.cleanup();
    }
  }
});
