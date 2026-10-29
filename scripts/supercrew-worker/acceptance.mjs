// Synthetic portable-state acceptance: every browser request is fulfilled locally.
// This script never contacts Supercrew, the receipt app, or a storage provider.
import assert from "node:assert/strict";
import { createPortableWorkerBrowser, verifySignedIn } from "./browser.mjs";
import { REPORT_URL } from "./core.mjs";
import { decryptSession, encryptSession } from "./session.mjs";

const origin = new URL(REPORT_URL).origin;
const empty = { cookies: [], origins: [] };
const key = "a1".repeat(32); // A fixture key; no account/session secrets are loaded.
const config = { reportDownloadsApproved: false };
const html =
  '<!doctype html><meta charset="utf-8"><title>Synthetic worker fixture</title><button role="tab">Timesheet Report</button><p>Sammy’s Visionary Landscape</p>';
let first, restored;
try {
  first = await createPortableWorkerBrowser(config, empty);
  await first.context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await first.context.addCookies([
    {
      name: "svl_fixture",
      value: "synthetic-cookie",
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await first.page.goto(REPORT_URL);
  await verifySignedIn(first.page);
  await first.page.evaluate(async () => {
    localStorage.setItem("svl_fixture", "synthetic-local-storage");
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("svl-fixture", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("fixture");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Fixture database could not open"));
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("fixture", "readwrite");
      transaction.objectStore("fixture").put("synthetic-indexeddb", "fixture");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(new Error("Fixture database could not save"));
    });
    database.close();
  });
  const state = await first.context.storageState({ indexedDB: true });
  assert.ok(state.origins.some((item) => item.indexedDB?.length));
  const portable = decryptSession(encryptSession(state, key), key);
  await first.context.close();
  await first.browser.close();
  first = null;
  restored = await createPortableWorkerBrowser(config, portable);
  await restored.context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await restored.page.goto(REPORT_URL);
  await verifySignedIn(restored.page);
  assert.equal(
    (await restored.context.cookies()).find((item) => item.name === "svl_fixture")?.value,
    "synthetic-cookie",
  );
  const values = await restored.page.evaluate(async () => {
    const local = localStorage.getItem("svl_fixture");
    const indexed = await new Promise((resolve, reject) => {
      const open = indexedDB.open("svl-fixture", 1);
      open.onerror = () => reject(new Error("Fixture database could not restore"));
      open.onsuccess = () => {
        const database = open.result;
        const request = database
          .transaction("fixture", "readonly")
          .objectStore("fixture")
          .get("fixture");
        request.onsuccess = () => {
          database.close();
          resolve(request.result);
        };
        request.onerror = () => {
          database.close();
          reject(new Error("Fixture data could not restore"));
        };
      };
    });
    return { local, indexed };
  });
  assert.deepEqual(values, { local: "synthetic-local-storage", indexed: "synthetic-indexeddb" });
  console.log(
    "Synthetic fresh-browser acceptance passed: company verification, cookies, local storage, and IndexedDB survive encrypted portable-state recovery.",
  );
} finally {
  for (const item of [first, restored]) {
    await item?.context?.close().catch(() => {});
    await item?.browser?.close().catch(() => {});
  }
}
