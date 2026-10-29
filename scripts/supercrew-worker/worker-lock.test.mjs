import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimWorker, WorkerLockError } from "./worker.mjs";

const DEAD_PID = 2147483000;
const TOKEN = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const dead = () => {
  throw Object.assign(new Error("SYNTHETIC process is absent"), { code: "ESRCH" });
};

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "svl-worker-lock-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "worker.lock");
  return {
    config: { stateDir },
    path,
    recovery: `${path}.recovery`,
    absent: (target = path) => assert.rejects(lstat(target), { code: "ENOENT" }),
  };
}

function lockError(code) {
  return (error) => error instanceof WorkerLockError && error.code === code;
}

test("a fresh private token lock releases once and removes its exit listener", async (t) => {
  const f = await fixture(t);
  const listeners = process.listenerCount("exit");
  const release = await claimWorker(f.config);
  t.after(release);
  const record = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(record.version, 1);
  assert.equal(record.pid, process.pid);
  assert.match(record.token, /^[a-f0-9-]{36}$/);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(process.listenerCount("exit"), listeners + 1);
  release();
  release();
  await f.absent();
  assert.equal(process.listenerCount("exit"), listeners);
});

test("legacy PID and new token records recover only a proven absent owner", async (t) => {
  for (const content of [
    `${DEAD_PID}\n`,
    `${JSON.stringify({ version: 1, pid: DEAD_PID, token: TOKEN })}\n`,
  ]) {
    const f = await fixture(t);
    await writeFile(f.path, content, { mode: 0o600 });
    const release = await claimWorker(f.config, {
      probeProcess: (pid) => {
        assert.equal(pid, DEAD_PID);
        dead();
      },
    });
    t.after(release);
    const record = JSON.parse(await readFile(f.path, "utf8"));
    assert.equal(record.pid, process.pid);
    assert.notEqual(record.token, TOKEN);
    await f.absent(f.recovery);
    release();
    await f.absent();
  }
});

test("a live owner is preserved without modifying its lock", async (t) => {
  const f = await fixture(t);
  const content = `${DEAD_PID}\n`;
  await writeFile(f.path, content);
  const before = await stat(f.path);
  await assert.rejects(
    claimWorker(f.config, { probeProcess: () => {} }),
    lockError("WORKER_LOCK_ACTIVE"),
  );
  assert.equal(await readFile(f.path, "utf8"), content);
  assert.equal((await stat(f.path)).ino, before.ino);
  await f.absent(f.recovery);
});

test("permission and unknown process errors preserve the lock and expose only fixed diagnostics", async (t) => {
  for (const code of ["EPERM", "EACCES", "UNKNOWN"]) {
    const f = await fixture(t);
    const content = `${DEAD_PID}\n`;
    await writeFile(f.path, content);
    await assert.rejects(
      claimWorker(f.config, {
        probeProcess: () => {
          throw Object.assign(new Error("SYNTHETIC-PRIVATE-TOKEN /private/report.xlsx"), { code });
        },
      }),
      (error) => {
        assert.ok(lockError("WORKER_LOCK_UNVERIFIED")(error));
        assert.doesNotMatch(error.message, /SYNTHETIC|private|report\.xlsx/);
        return true;
      },
    );
    assert.equal(await readFile(f.path, "utf8"), content);
    await f.absent(f.recovery);
  }
});

test("empty, oversized, malformed and nonpositive owner records fail closed before probing", async (t) => {
  for (const content of [
    "",
    "0\n",
    "-1\n",
    "01\n",
    "1e3\n",
    "2147483648\n",
    "9".repeat(1025),
    "not a process record",
    JSON.stringify({ version: 1, pid: String(DEAD_PID), token: TOKEN }),
    JSON.stringify({ version: 1, pid: DEAD_PID, token: "invalid" }),
    JSON.stringify({ version: 2, pid: DEAD_PID, token: TOKEN }),
  ]) {
    const f = await fixture(t);
    await writeFile(f.path, content);
    let probes = 0;
    await assert.rejects(
      claimWorker(f.config, { probeProcess: () => probes++ }),
      lockError("WORKER_LOCK_UNVERIFIED"),
    );
    assert.equal(probes, 0);
    assert.equal(await readFile(f.path, "utf8"), content);
    await f.absent(f.recovery);
  }
});

test("symlink and directory locks remain untouched", async (t) => {
  const f = await fixture(t);
  const target = join(f.config.stateDir, "source-record");
  await writeFile(target, `${DEAD_PID}\n`);
  await symlink(target, f.path);
  await assert.rejects(
    claimWorker(f.config, { probeProcess: dead }),
    lockError("WORKER_LOCK_UNVERIFIED"),
  );
  assert.ok((await lstat(f.path)).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), `${DEAD_PID}\n`);
  await rm(f.path);
  await mkdir(f.path);
  await assert.rejects(
    claimWorker(f.config, { probeProcess: dead }),
    lockError("WORKER_LOCK_UNVERIFIED"),
  );
  assert.ok((await lstat(f.path)).isDirectory());
});

test("an existing unverifiable recovery guard is preserved even when the main lock is absent", async (t) => {
  const f = await fixture(t);
  await writeFile(f.recovery, "SYNTHETIC interrupted recovery");
  await assert.rejects(
    claimWorker(f.config, { probeProcess: dead }),
    lockError("WORKER_LOCK_RECOVERY_BUSY"),
  );
  assert.equal(await readFile(f.recovery, "utf8"), "SYNTHETIC interrupted recovery");
  await f.absent();
});

test("two stale contenders produce exactly one owner and preserve that owner's lock", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, `${DEAD_PID}\n`);
  const probeProcess = async (pid) => {
    assert.equal(pid, DEAD_PID);
    await Promise.resolve();
    dead();
  };
  const results = await Promise.allSettled([
    claimWorker(f.config, { probeProcess }),
    claimWorker(f.config, { probeProcess }),
  ]);
  const owners = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(owners.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(lockError("WORKER_LOCK_RECOVERY_BUSY")(rejected[0].reason));
  const release = owners[0].value;
  t.after(release);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).pid, process.pid);
  await f.absent(f.recovery);
  release();
  await f.absent();
});

test("a lock replaced while the absent-owner probe is pending is never reclaimed", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, `${DEAD_PID}\n`);
  const replacement = JSON.stringify({ version: 1, pid: process.pid, token: TOKEN });
  await assert.rejects(
    claimWorker(f.config, {
      probeProcess: async () => {
        await rename(f.path, `${f.path}.old`);
        await writeFile(f.path, replacement);
        dead();
      },
    }),
    lockError("WORKER_LOCK_UNVERIFIED"),
  );
  assert.equal(await readFile(f.path, "utf8"), replacement);
  await f.absent(f.recovery);
});

test("release preserves a replacement inode even if it copies the original token record", async (t) => {
  const f = await fixture(t);
  const release = await claimWorker(f.config);
  t.after(release);
  const content = await readFile(f.path, "utf8");
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, content);
  release();
  assert.equal(await readFile(f.path, "utf8"), content);
});

test("release preserves changed owner content on the original inode", async (t) => {
  const f = await fixture(t);
  const release = await claimWorker(f.config);
  t.after(release);
  await writeFile(f.path, "SYNTHETIC replacement owner");
  release();
  assert.equal(await readFile(f.path, "utf8"), "SYNTHETIC replacement owner");
});

test("a failed initial write cleans only the file created by that setup", async (t) => {
  const f = await fixture(t);
  const listeners = process.listenerCount("exit");
  await assert.rejects(
    claimWorker(f.config, {
      writeRecord: (descriptor) => {
        writeFileSync(descriptor, "SYNTHETIC partial record");
        throw new Error("SYNTHETIC private write failure");
      },
    }),
    lockError("WORKER_LOCK_SETUP_FAILED"),
  );
  await f.absent();
  await f.absent(f.recovery);
  assert.equal(process.listenerCount("exit"), listeners);
});

test("a failed write cannot clean up a different replacement file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    claimWorker(f.config, {
      writeRecord: (descriptor) => {
        writeFileSync(descriptor, "SYNTHETIC partial record");
        // Synchronous fixture replacement models a competing/manual change.
        writeFileSync(`${f.path}.next`, "SYNTHETIC replacement owner");
        // Renaming over the open file keeps the failed setup's descriptor distinct.
        renameSync(`${f.path}.next`, f.path);
        throw new Error("SYNTHETIC setup failure");
      },
    }),
    lockError("WORKER_LOCK_SETUP_FAILED"),
  );
  assert.equal(await readFile(f.path, "utf8"), "SYNTHETIC replacement owner");
});
