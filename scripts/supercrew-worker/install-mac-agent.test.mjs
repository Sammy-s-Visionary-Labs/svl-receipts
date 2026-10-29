import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installPreparedMacWorker,
  launchAgentPlist,
  MAC_AGENT_LABEL,
  prepareMacWorker,
  RELEASE_FILES,
} from "./install-mac-agent.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "svl-mac-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "synthetic.env");
  const token = "SYNTHETIC-PRIVATE-WORKER-TOKEN-1234567890";
  await writeFile(
    envFile,
    [
      "LABOR_APP_URL=https://fixture.example",
      "LABOR_APP_HOST=fixture.example",
      `LABOR_WORKER_TOKEN=${token}`,
      `LABOR_SESSION_ENCRYPTION_KEY=${"ab".repeat(32)}`,
      "SUPERCREW_REPORT_DOWNLOADS_APPROVED=1",
    ].join("\n"),
    { mode: 0o600 },
  );
  const preparedDirectory = join(directory, "prepared");
  const plan = await prepareMacWorker({
    outputDirectory: preparedDirectory,
    envFile,
    appOrigin: "https://fixture.example",
    userHome: join(directory, "fake-home"),
    nodePath: process.execPath,
    npmCli: process.execPath, // Existence-only preflight; installation commands are intercepted below.
  });
  return { directory, preparedDirectory, envFile, plan, token };
}

test("preparation stages only pinned files, escapes paths and contains no private credentials", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await readdir(join(f.preparedDirectory, "release"))).sort(),
    [...RELEASE_FILES].sort(),
  );
  const planText = await readFile(join(f.preparedDirectory, "plan.json"), "utf8");
  const plist = await readFile(join(f.preparedDirectory, `${MAC_AGENT_LABEL}.plist`), "utf8");
  assert.equal(planText.includes(f.token), false);
  assert.equal(plist.includes(f.token), false);
  assert.equal(plist.includes("LABOR_WORKER_TOKEN"), false);
  assert.ok(plist.includes("<key>KeepAlive</key><true/>"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(plist.includes("<key>ThrottleInterval</key><integer>60</integer>"));
  assert.ok(plist.includes("<key>LimitLoadToSessionType</key><string>Aqua</string>"));
  assert.equal(plist.includes("--connect"), false);
  assert.equal((await stat(f.preparedDirectory)).mode & 0o777, 0o700);
  await assert.rejects(stat(f.plan.installationRoot), { code: "ENOENT" });
  assert.ok(
    launchAgentPlist({ ...f.plan, nodePath: "/space & <test>/node" }).includes(
      "/space &amp; &lt;test&gt;/node",
    ),
  );
});

test("installation uses private new runtime and safe environment without starting or connecting a worker", async (t) => {
  const f = await fixture(t);
  const calls = [];
  await installPreparedMacWorker(f.preparedDirectory, f.envFile, {
    uid: 999,
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "/bin/launchctl" ? 113 : 0;
    },
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args, ["print", `gui/999/${MAC_AGENT_LABEL}`]);
  assert.ok(calls[1].args.includes("--ignore-scripts"));
  assert.deepEqual(calls[2].args.slice(-2), ["install", "chromium"]);
  assert.ok(calls[3].args.at(-1).includes("browser.close()"));
  assert.equal(JSON.stringify(calls).includes(f.token), false);
  assert.equal(JSON.stringify(calls).includes("NODE_OPTIONS"), false);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.env.HOME, f.plan.userHome);
    assert.ok(call.options.env.PLAYWRIGHT_BROWSERS_PATH.startsWith(f.plan.installationRoot));
  }
  assert.deepEqual(await readdir(join(f.plan.installationRoot, "runtime")), []);
  assert.equal((await stat(join(f.plan.installationRoot, "production.env"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.plan.installationRoot, "runtime"))).mode & 0o777, 0o700);
  assert.equal(
    await readFile(join(f.plan.releaseDirectory, "hosted.mjs"), "utf8"),
    await readFile(new URL("./hosted.mjs", import.meta.url), "utf8"),
  );
  const plist = await readFile(f.plan.plistPath, "utf8");
  assert.ok(plist.includes(join(f.plan.releaseDirectory, "mac-service.mjs")));
  assert.ok(plist.includes(join(f.plan.releaseDirectory, "browsers")));
  assert.equal(plist.includes(f.preparedDirectory), false);
});

test("active agent, changed release or wrong app origin blocks install before touching runtime", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installPreparedMacWorker(f.preparedDirectory, f.envFile, { runProcess: async () => 0 }),
    /Stop the installed LaunchAgent/,
  );
  await assert.rejects(stat(f.plan.installationRoot), { code: "ENOENT" });
  const source = join(f.preparedDirectory, "release", "hosted.mjs");
  const original = await readFile(source);
  await writeFile(source, "unexpected changed code");
  let calls = 0;
  await assert.rejects(
    installPreparedMacWorker(f.preparedDirectory, f.envFile, {
      runProcess: async () => {
        calls++;
        return 113;
      },
    }),
    /files changed/,
  );
  assert.equal(calls, 0);
  await writeFile(source, original);
  const text = await readFile(f.envFile, "utf8");
  await writeFile(f.envFile, text.replaceAll("fixture.example", "wrong.example"));
  await assert.rejects(
    installPreparedMacWorker(f.preparedDirectory, f.envFile, {
      runProcess: async () => {
        calls++;
        return 113;
      },
    }),
    /origin/,
  );
  assert.equal(calls, 0);
});

test("failed dependency setup never publishes credentials, a release or a login LaunchAgent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installPreparedMacWorker(f.preparedDirectory, f.envFile, {
      runProcess: async (command) => (command === "/bin/launchctl" ? 113 : 1),
    }),
    /dependency installation failed/,
  );
  await assert.rejects(stat(f.plan.plistPath), { code: "ENOENT" });
  await assert.rejects(stat(join(f.plan.installationRoot, "production.env")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(f.plan.installationRoot, "releases")), []);
});

test("cloud acquisitions are explicitly opt-in when this Mac owns production", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/supercrew-labor.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /import:\s*\n\s*if: vars\.LABOR_WORKER_HOST == 'github'/);
});
