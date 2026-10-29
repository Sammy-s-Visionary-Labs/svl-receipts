import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { appReady, localConfig, runLocal } from "./local.mjs";

const directory = "/tmp/TEST-local-labor";
const environment = {
  LABOR_APP_URL: "http://127.0.0.1:3150",
  LABOR_WORKER_TOKEN: "TEST-LOCAL-WORKER-TOKEN-123456789012345",
  LABOR_SESSION_ENCRYPTION_KEY: "a1".repeat(32),
  SUPERCREW_REPORT_DOWNLOADS_APPROVED: "1",
};
const readyResponse = () => Response.json({ sync: { status: "idle" }, claimable: false });

// Every child, signal, clock and HTTP response is synthetic. No process starts
// and no app, database, source provider or report storage is contacted.
function fixture(options = {}) {
  const events = [];
  const children = [];
  const signals = new EventEmitter();
  let now = 0;
  let probes = 0;
  const operations = {
    signals,
    now: () => now,
    log: (message) => events.push(["log", message]),
    warn: (message) => {
      events.push(["warn", message]);
      options.onWarn?.({ signals, events, children });
    },
    delay: async (ms, _value, { signal }) => {
      signal.throwIfAborted();
      events.push(["delay", ms]);
      now += options.clockStep ?? ms;
      await options.onDelay?.({ signals, events });
      signal.throwIfAborted();
    },
    fetch: async (url, init) => {
      probes++;
      events.push(["probe", probes]);
      assert.equal(url, "http://127.0.0.1:3150/api/manager/labor/worker");
      assert.equal(init.headers.Authorization, `Bearer ${environment.LABOR_WORKER_TOKEN}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      return options.response?.(probes) ?? readyResponse();
    },
    spawn: (executable, args, config) => {
      const role = args.at(-1) === "--watch" ? "worker" : "web";
      events.push(["spawn", role]);
      assert.equal(executable, process.execPath);
      assert.equal(config.cwd, directory);
      assert.equal(config.env.LABOR_APP_URL, environment.LABOR_APP_URL);
      assert.equal(config.env.LABOR_WORKER_TOKEN, environment.LABOR_WORKER_TOKEN);
      assert.equal(config.stdio, "inherit");
      const child = new EventEmitter();
      child.role = role;
      child.args = args;
      child.environment = config.env;
      child.kills = [];
      child.exited = false;
      child.exit = (code = 0) => {
        assert.equal(child.exited, false, `${role} exited more than once`);
        child.exited = true;
        events.push(["exit", role, code]);
        child.emit("exit", code);
      };
      child.kill = (signal) => {
        assert.equal(child.exited, false, `An exited ${role} was killed`);
        child.kills.push(signal);
        events.push(["kill", role, signal]);
        queueMicrotask(() => child.exit(0));
        return true;
      };
      children.push(child);
      queueMicrotask(() => {
        if (options.onSpawn) options.onSpawn({ child, signals, events });
        else if (role === "worker") signals.emit("SIGINT");
      });
      return child;
    },
  };
  return {
    operations,
    events,
    children,
    signals,
    assertClean() {
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
      assert.equal(signals.listenerCount("SIGHUP"), 0);
      assert.ok(
        children.every((child) => child.exited),
        "A supervisor-owned child was orphaned",
      );
    },
  };
}

test("full local mode starts web, verifies authenticated readiness, then starts the queue worker", async () => {
  const value = fixture({
    response: (count) => (count === 1 ? new Response(null, { status: 503 }) : readyResponse()),
  });
  await runLocal([], environment, directory, value.operations);
  assert.deepEqual(
    value.events.filter(([event]) => event === "probe" || event === "spawn"),
    [
      ["probe", 1],
      ["spawn", "web"],
      ["probe", 2],
      ["spawn", "worker"],
    ],
  );
  assert.deepEqual(value.children[0].args, [
    `${directory}/node_modules/next/dist/bin/next`,
    "dev",
    "apps/web",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3150",
  ]);
  assert.deepEqual(value.children[1].args, [
    `${directory}/scripts/supercrew-worker/hosted.mjs`,
    "--watch",
  ]);
  assert.deepEqual(value.children[0].kills, ["SIGTERM"]);
  assert.ok(!JSON.stringify(value.events).includes(environment.LABOR_WORKER_TOKEN));
  value.assertClean();
});

test("an existing authenticated matching app is reused and is never owned or killed", async () => {
  const value = fixture();
  await runLocal([], environment, directory, value.operations);
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["worker"],
  );
  assert.deepEqual(
    value.events.filter(([event]) => event === "kill"),
    [["kill", "worker", "SIGTERM"]],
  );
  value.assertClean();
});

test("the worker receives runtime and worker settings without website secrets or preload controls", async () => {
  const runtime = {
    PATH: "/TEST/bin",
    HOME: "/TEST/home",
    TMPDIR: "/TEST/tmp",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "America/New_York",
    PLAYWRIGHT_BROWSERS_PATH: "/TEST/browsers",
    XDG_CACHE_HOME: "/TEST/cache",
    HTTPS_PROXY: "http://TEST-proxy:8080",
    no_proxy: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: "/TEST/ca.pem",
    NODE_USE_ENV_PROXY: "1",
    SystemRoot: "C:\\TEST-Windows",
    TEMP: "C:\\TEST-Temp",
  };
  const secrets = {
    SUPABASE_SERVICE_ROLE_KEY: "TEST-web-only-service-role",
    HOUSECALL_API_KEY: "TEST-web-only-housecall",
    OPENAI_API_KEY: "TEST-web-only-ai",
    LABOR_GITHUB_DISPATCH_TOKEN: "TEST-web-only-dispatch",
    SUPERCREW_UNRELATED_SECRET: "TEST-not-a-worker-control",
    NODE_OPTIONS: "--env-file=/TEST/private.env --require=/TEST/preload.cjs",
    NODE_PATH: "/TEST/preloaded-modules",
    LD_PRELOAD: "/TEST/preload.so",
    DYLD_INSERT_LIBRARIES: "/TEST/preload.dylib",
    GITHUB_OUTPUT: "/TEST/unrelated-workflow-output",
    npm_config_node_options: "--env-file=/TEST/private.env",
  };
  const value = fixture({
    response: (count) => (count === 1 ? new Response(null, { status: 503 }) : readyResponse()),
  });
  const env = { ...environment, ...runtime, ...secrets, LABOR_RUN_ID: "local:TEST" };
  await runLocal([], env, directory, value.operations);
  const web = value.children.find((child) => child.role === "web");
  const worker = value.children.find((child) => child.role === "worker");
  assert.deepEqual(web.environment, env);
  assert.deepEqual(worker.environment, { ...environment, ...runtime, LABOR_RUN_ID: "local:TEST" });
  assert.notEqual(worker.environment, web.environment);
  value.assertClean();
});

test("worker-only mode waits for the existing app without ever starting a website", async () => {
  const value = fixture({
    response: (count) => (count < 3 ? new Response(null, { status: 503 }) : readyResponse()),
  });
  await runLocal(["--worker-only"], environment, directory, value.operations);
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["worker"],
  );
  assert.equal(value.events.filter(([event]) => event === "probe").length, 3);
  value.assertClean();
});

test("worker-only startup timeout creates no web or worker child", async () => {
  const value = fixture({ response: () => new Response(null, { status: 503 }), clockStep: 90000 });
  await assert.rejects(
    runLocal(["--worker-only"], environment, directory, value.operations),
    /app is not ready/,
  );
  assert.equal(value.children.length, 0);
  value.assertClean();
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} stops the worker before the owned website and removes signal listeners`, async () => {
    const value = fixture({
      response: (count) => (count === 1 ? new Response(null, { status: 503 }) : readyResponse()),
      onSpawn: ({ child, signals }) => {
        if (child.role === "worker") signals.emit(signal);
      },
    });
    await runLocal([], environment, directory, value.operations);
    assert.deepEqual(
      value.events.filter(([event]) => event === "kill"),
      [
        ["kill", "worker", "SIGTERM"],
        ["kill", "web", "SIGTERM"],
      ],
    );
    assert.ok(
      value.events.findIndex(([event, role]) => event === "exit" && role === "worker") <
        value.events.findIndex(([event, role]) => event === "kill" && role === "web"),
    );
    value.assertClean();
  });
}

test("stopping a reused-app worker never kills the external app", async () => {
  const value = fixture({ onSpawn: ({ signals }) => signals.emit("SIGINT") });
  await runLocal([], environment, directory, value.operations);
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["worker"],
  );
  assert.deepEqual(
    value.events.filter(([event]) => event === "kill"),
    [["kill", "worker", "SIGTERM"]],
  );
  value.assertClean();
});

test("website startup failure never starts a worker", async () => {
  const value = fixture({
    response: () => new Response(null, { status: 503 }),
    onSpawn: ({ child }) => child.exit(1),
  });
  await assert.rejects(
    runLocal([], environment, directory, value.operations),
    /local website stopped/,
  );
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["web"],
  );
  value.assertClean();
});

test("a website that never becomes ready is stopped without running the worker", async () => {
  const value = fixture({ response: () => new Response(null, { status: 503 }), clockStep: 90000 });
  await assert.rejects(runLocal([], environment, directory, value.operations), /app is not ready/);
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["web"],
  );
  assert.deepEqual(value.children[0].kills, ["SIGTERM"]);
  value.assertClean();
});

test("wrong credentials on an existing app do not start a worker or a second app", async () => {
  for (const status of [401, 403]) {
    const value = fixture({ response: () => new Response(null, { status }) });
    await assert.rejects(
      runLocal([], environment, directory, value.operations),
      /does not accept this worker credential/,
    );
    assert.equal(value.children.length, 0);
    value.assertClean();
  }
});

test("credentials rejected after web startup stop the owned web and never start a worker", async () => {
  const value = fixture({
    response: (count) => new Response(null, { status: count === 1 ? 503 : 401 }),
  });
  await assert.rejects(
    runLocal([], environment, directory, value.operations),
    /does not accept this worker credential/,
  );
  assert.deepEqual(
    value.children.map((child) => child.role),
    ["web"],
  );
  assert.deepEqual(value.children[0].kills, ["SIGTERM"]);
  value.assertClean();
});

for (const exitCode of [0, 1]) {
  test(`worker exit ${exitCode} keeps the owned website available until explicit shutdown`, async () => {
    const value = fixture({
      response: (count) => (count === 1 ? new Response(null, { status: 503 }) : readyResponse()),
      onSpawn: ({ child }) => {
        if (child.role === "worker") child.exit(exitCode);
      },
      onWarn: ({ signals, children }) => {
        const web = children.find((child) => child.role === "web");
        assert.equal(web.exited, false);
        assert.deepEqual(web.kills, []);
        assert.equal(children.filter((child) => child.role === "worker").length, 1);
        queueMicrotask(() => signals.emit("SIGINT"));
      },
    });
    await runLocal([], environment, directory, value.operations);
    assert.deepEqual(value.children[0].kills, ["SIGTERM"]);
    assert.deepEqual(value.children[1].kills, []);
    const warnings = value.events.filter(([event]) => event === "warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][1], /local Supercrew queue worker is not running/);
    assert.match(warnings[0][1], /Another configured worker may still handle them/);
    assert.match(warnings[0][1], /website remains available/);
    assert.match(warnings[0][1], /npm run dev:labor-watch/);
    assert.ok(!JSON.stringify(warnings).includes(environment.LABOR_WORKER_TOKEN));
    value.assertClean();
  });

  test(`worker-only exit ${exitCode} reports unavailable downloads without stopping the existing website`, async () => {
    const value = fixture({ onSpawn: ({ child }) => child.exit(exitCode) });
    await assert.rejects(
      runLocal(["--worker-only"], environment, directory, value.operations),
      /local Supercrew queue worker is not running/,
    );
    assert.deepEqual(
      value.children.map((child) => child.role),
      ["worker"],
    );
    assert.deepEqual(value.children[0].kills, []);
    value.assertClean();
  });
}

test("a website exit remains a failure after the worker has stopped", async () => {
  const value = fixture({
    response: (count) => (count === 1 ? new Response(null, { status: 503 }) : readyResponse()),
    onSpawn: ({ child }) => {
      if (child.role === "worker") child.exit(1);
    },
    onWarn: ({ children }) => {
      children.find((child) => child.role === "web").exit(1);
    },
  });
  await assert.rejects(runLocal([], environment, directory, value.operations), /website stopped/);
  assert.ok(value.children.every((child) => child.kills.length === 0));
  value.assertClean();
});

test("readiness requires the authenticated shared-worker contract and blocks redirects", async () => {
  const config = localConfig(environment, directory);
  const requests = [];
  assert.equal(
    await appReady(config, async (url, init) => {
      requests.push({ url, init });
      return readyResponse();
    }),
    true,
  );
  assert.equal(requests[0].url, `${environment.LABOR_APP_URL}/api/manager/labor/worker`);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${environment.LABOR_WORKER_TOKEN}`);
  assert.equal(requests[0].init.redirect, "error");
  for (const body of [{ sync: {} }, { claimable: false }, { sync: {}, claimable: "false" }]) {
    await assert.rejects(
      appReady(config, async () => Response.json(body)),
      /shared-worker polling update/,
    );
  }
  assert.equal(
    await appReady(config, async () => {
      throw new TypeError("redirect rejected");
    }),
    false,
  );
});

test("readiness cancellation remains cancellation rather than a successful probe", async () => {
  const controller = new AbortController();
  const reason = new Error("TEST stop");
  controller.abort(reason);
  await assert.rejects(
    appReady(
      localConfig(environment, directory),
      async () => {
        throw new Error("TEST fetch aborted");
      },
      controller.signal,
    ),
    (error) => error === reason,
  );
});

test("configuration defaults to local3150 and rejects invalid host, credential, key and download scope before spawning", async () => {
  assert.equal(
    localConfig({ ...environment, LABOR_APP_URL: undefined }, directory).appUrl,
    "http://127.0.0.1:3150",
  );
  const invalid = [
    { LABOR_APP_URL: "https://fixture.example" },
    { LABOR_APP_URL: "http://127.0.0.1.evil.example:3150" },
    { LABOR_APP_URL: "http://user:password@localhost:3150" },
    { LABOR_APP_URL: "http://localhost:3150/path" },
    { LABOR_APP_URL: "http://localhost:3150?token=TEST" },
    { LABOR_APP_URL: "http://localhost:3150#TEST" },
    { LABOR_WORKER_TOKEN: undefined },
    { LABOR_WORKER_TOKEN: "short" },
    { LABOR_SESSION_ENCRYPTION_KEY: undefined },
    { LABOR_SESSION_ENCRYPTION_KEY: "invalid" },
    { SUPERCREW_REPORT_DOWNLOADS_APPROVED: undefined },
    { SUPERCREW_REPORT_DOWNLOADS_APPROVED: "true" },
  ];
  for (const patch of invalid) {
    const value = fixture();
    await assert.rejects(runLocal([], { ...environment, ...patch }, directory, value.operations));
    assert.equal(value.children.length, 0);
    assert.equal(value.events.length, 0);
    value.assertClean();
  }
  await assert.rejects(runLocal(["--unknown"], environment, directory), /Usage/);
});
