import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workerConfig } from "./core.mjs";
import { watchHostedWorker } from "./hosted.mjs";

const lease = {
  commandId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  leaseToken: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  period: { from: "2020-01-01", to: "2020-01-14" },
  sync: { timeZone: "America/New_York" },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Stopped", "AbortError"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {
      once: true,
    });
  });
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "svl-hosted-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = workerConfig(
    {
      LABOR_WORKER_TOKEN: "SYNTHETIC-PRIVATE-WATCH-TOKEN-123456789",
      LABOR_APP_URL: "https://fixture.example",
      LABOR_APP_HOST: "fixture.example",
      LABOR_SESSION_ENCRYPTION_KEY: "a1".repeat(32),
      SUPERCREW_REPORT_DOWNLOADS_APPROVED: "1",
    },
    directory,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = [];
  const waits = [];
  const messages = [];
  let polls = 0;
  const operations = {
    signal: controller.signal,
    runId: "local:synthetic-watch",
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.example");
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${config.token}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      const path = new URL(url).pathname;
      if (path === "/api/manager/labor/worker") {
        assert.equal(init.method ?? "GET", "GET");
        events.push("poll");
        polls++;
        const response = options.pollResponse
          ? await options.pollResponse(polls)
          : { claimable: false };
        return Response.json(response);
      }
      if (path === "/api/manager/labor/worker/claim") {
        assert.equal(init.method, "POST");
        assert.equal(JSON.parse(init.body).runId, operations.runId);
        events.push("claim");
        return Response.json({
          claim: options.competingClaim ? null : lease,
        });
      }
      throw new Error(`Unexpected synthetic worker path: ${path}`);
    },
    runImport: async (actualConfig, actualClaim, runOperations) => {
      assert.equal(actualConfig, config);
      assert.deepEqual(actualClaim, lease);
      assert.equal(runOperations.signal, controller.signal);
      events.push("run");
      return { duplicate: false };
    },
    sleep: async (milliseconds, signal) => {
      assert.equal(signal, controller.signal);
      waits.push(milliseconds);
      controller.abort();
    },
    log: (message) => messages.push(String(message)),
    error: (message) => messages.push(String(message)),
  };
  const lock = join(config.stateDir, "worker.lock");
  const assertReleased = () => assert.rejects(stat(lock), { code: "ENOENT" });
  return { config, controller, operations, events, waits, messages, lock, assertReleased };
}

test("hosted watch polls idle state without claiming or opening source work", async (t) => {
  const f = await fixture(t);
  f.operations.sleep = async (milliseconds, signal) => {
    assert.equal(signal, f.controller.signal);
    f.waits.push(milliseconds);
    assert.equal((await stat(f.lock)).mode & 0o777, 0o600);
    if (f.waits.length === 3) f.controller.abort();
  };
  await watchHostedWorker(f.config, f.operations);
  assert.deepEqual(f.events, ["poll", "poll", "poll"]);
  assert.deepEqual(f.waits, [15000, 15000, 15000]);
  await f.assertReleased();
});

test("hosted watch runs a claimable manual request while the daily schedule is paused", async (t) => {
  const f = await fixture(t, {
    pollResponse: async () => ({ claimable: true, sync: { enabled: false, command: "run" } }),
  });
  await watchHostedWorker(f.config, f.operations);
  assert.deepEqual(f.events, ["poll", "claim", "run"]);
  assert.deepEqual(f.waits, [15000]);
  await f.assertReleased();
});

test("hosted watch does no source work when another worker wins the claim", async (t) => {
  const f = await fixture(t, {
    pollResponse: async () => ({ claimable: true }),
    competingClaim: true,
  });
  await watchHostedWorker(f.config, f.operations);
  assert.deepEqual(f.events, ["poll", "claim"]);
  assert.deepEqual(f.waits, [15000]);
  await f.assertReleased();
});

test("hosted watch waits for its finite import before scheduling another poll", async (t) => {
  const started = deferred();
  const release = deferred();
  const f = await fixture(t, { pollResponse: async () => ({ claimable: true }) });
  f.operations.runImport = async (_config, _claim, operations) => {
    assert.equal(operations.signal, f.controller.signal);
    f.events.push("run:start");
    started.resolve();
    await release.promise;
    f.events.push("run:finish");
  };
  const watching = watchHostedWorker(f.config, f.operations);
  t.after(() => release.resolve());
  await started.promise;
  await Promise.resolve();
  assert.deepEqual(f.events, ["poll", "claim", "run:start"]);
  assert.equal(f.waits.length, 0);
  release.resolve();
  await watching;
  assert.deepEqual(f.events, ["poll", "claim", "run:start", "run:finish"]);
  assert.deepEqual(f.waits, [15000]);
  await f.assertReleased();
});

test("hosted watch caps transient polling backoff and resets it after a successful poll", async (t) => {
  const f = await fixture(t, {
    pollResponse: async (poll) => {
      if (poll !== 5)
        throw new Error(
          "SYNTHETIC-PRIVATE-WATCH-TOKEN-123456789 https://private.example?secret=hidden",
        );
      return { claimable: false };
    },
  });
  f.operations.sleep = async (milliseconds, signal) => {
    assert.equal(signal, f.controller.signal);
    f.waits.push(milliseconds);
    if (f.waits.length === 6) f.controller.abort();
  };
  await watchHostedWorker(f.config, f.operations);
  assert.deepEqual(f.waits, [15000, 30000, 60000, 60000, 15000, 15000]);
  assert.deepEqual(f.events, Array(6).fill("poll"));
  for (const message of f.messages)
    for (const secret of [f.config.token, f.config.sessionEncryptionKey, "secret=hidden"])
      assert.equal(message.includes(secret), false);
  await f.assertReleased();
});

test("hosted watch backs off after an import failure instead of replaying the old claim", async (t) => {
  const f = await fixture(t, {
    pollResponse: async (poll) => ({ claimable: poll === 1 }),
  });
  f.operations.runImport = async () => {
    f.events.push("run:failed");
    throw new Error("SYNTHETIC finite import failed");
  };
  f.operations.sleep = async (milliseconds) => {
    f.waits.push(milliseconds);
    if (f.waits.length === 2) f.controller.abort();
  };
  await watchHostedWorker(f.config, f.operations);
  assert.deepEqual(f.events, ["poll", "claim", "run:failed", "poll"]);
  assert.deepEqual(f.waits, [15000, 15000]);
  await f.assertReleased();
});

test("cancelling an idle hosted watch interrupts its wait and releases its private lock", async (t) => {
  const sleeping = deferred();
  const f = await fixture(t);
  f.operations.sleep = async (_milliseconds, signal) => {
    sleeping.resolve();
    await untilAborted(signal);
  };
  const watching = watchHostedWorker(f.config, f.operations);
  await sleeping.promise;
  assert.equal((await stat(f.lock)).mode & 0o777, 0o600);
  f.controller.abort();
  await watching;
  assert.deepEqual(f.events, ["poll"]);
  await f.assertReleased();
});

test("cancelling a claimed hosted run passes cancellation through without another poll", async (t) => {
  const started = deferred();
  const f = await fixture(t, { pollResponse: async () => ({ claimable: true }) });
  f.operations.runImport = async (_config, _claim, operations) => {
    assert.equal(operations.signal, f.controller.signal);
    f.events.push("run");
    started.resolve();
    await untilAborted(operations.signal);
  };
  const watching = watchHostedWorker(f.config, f.operations);
  await started.promise;
  f.controller.abort();
  await watching;
  assert.deepEqual(f.events, ["poll", "claim", "run"]);
  assert.deepEqual(f.waits, []);
  await f.assertReleased();
});

test("a second hosted watch cannot share an active local worker directory", async (t) => {
  const sleeping = deferred();
  const f = await fixture(t);
  f.operations.sleep = async (_milliseconds, signal) => {
    sleeping.resolve();
    await untilAborted(signal);
  };
  const watching = watchHostedWorker(f.config, f.operations);
  await sleeping.promise;
  const second = new AbortController();
  await assert.rejects(
    watchHostedWorker(f.config, { ...f.operations, signal: second.signal }),
    /another.*worker/i,
  );
  assert.equal((await stat(f.lock)).mode & 0o777, 0o600);
  assert.deepEqual(f.events, ["poll"]);
  f.controller.abort();
  await watching;
  await f.assertReleased();
});

test("malformed claimable state is fatal before any claim or source work", async (t) => {
  for (const value of [undefined, null, "true", 1]) {
    const f = await fixture(t, { pollResponse: async () => ({ claimable: value }) });
    await assert.rejects(watchHostedWorker(f.config, f.operations));
    assert.deepEqual(f.events, ["poll"]);
    assert.deepEqual(f.waits, []);
    await f.assertReleased();
  }
});

test("invalid watch configuration fails before polling or consuming a command", async (t) => {
  const cases = [
    { config: { sessionEncryptionKey: "SYNTHETIC-INVALID-KEY" } },
    { config: { reportDownloadsApproved: false } },
    { operations: { pollEveryMs: 0 } },
    { operations: { pollEveryMs: 15000, maxBackoffMs: 14999 } },
  ];
  for (const item of cases) {
    const f = await fixture(t);
    await assert.rejects(
      watchHostedWorker({ ...f.config, ...item.config }, { ...f.operations, ...item.operations }),
    );
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.waits, []);
    await f.assertReleased();
  }
});
