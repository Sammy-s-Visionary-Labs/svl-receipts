import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const code = readFileSync(new URL("./Code.gs", import.meta.url), "utf8");
function fixture({ wrongMailbox = false, failConfirm = false } = {}) {
  const properties = new Map([
    ["SVL_IMPORT_SECRET", "s".repeat(40)],
    ["SVL_CURSOR", "1789560000"],
  ]);
  const calls = [];
  let unlocked = false;
  const context = createContext({
    console: { log() {} },
    Date,
    JSON,
    Number,
    Math,
    Error,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => properties.get(k),
        setProperty: (k, v) => properties.set(k, v),
        deleteProperty: (k) => properties.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {
          unlocked = true;
        },
      }),
    },
    Utilities: {
      base64DecodeWebSafe: (s) => [...Buffer.from(s, "base64url")],
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (alg, bytes) => [...createHash(alg).update(Buffer.from(bytes)).digest()],
    },
    Gmail: {
      Users: {
        getProfile: () => ({
          emailAddress: wrongMailbox ? "wrong@example.invalid" : "recisvl@gmail.com",
        }),
        Messages: {
          list: () => {
            calls.push("list");
            return { messages: [{ id: "test123" }] };
          },
          get: () => ({ id: "test123", raw: Buffer.from("TEST RECEIPT").toString("base64url") }),
        },
      },
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/confirm") && failConfirm) return { getResponseCode: () => 503 };
        return {
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify(
              url.endsWith("/api/email-imports")
                ? {
                    id: "import1",
                    status: "awaiting_upload",
                    uploadUrl:
                      "https://fixture.supabase.co/storage/v1/object/upload/sign/receipt-emails/import1/original.eml?token=test",
                  }
                : { ok: true },
            ),
        };
      },
    },
  });
  runInContext(code, context);
  return { run: () => context.importReceiptEmails(), properties, calls, unlocked: () => unlocked };
}
test("checks the exact mailbox before reading any messages", () => {
  const f = fixture({ wrongMailbox: true });
  assert.throws(f.run, /recisvl@gmail.com/);
  assert.equal(f.calls.length, 0);
  assert.ok(f.unlocked());
});
test("keeps the scan window and cursor on an uncertain acknowledgement", () => {
  const f = fixture({ failConfirm: true });
  assert.throws(f.run, /503/);
  assert.equal(f.properties.get("SVL_CURSOR"), "1789560000");
  assert.ok(f.properties.get("SVL_WINDOW_END"));
  assert.ok(f.unlocked());
});
test("uploads the immutable original directly and advances only after acceptance", () => {
  const f = fixture();
  f.run();
  const upload = f.calls.find((c) => c.url?.includes(".supabase.co/"));
  assert.equal(upload.options.method, "put");
  assert.equal(upload.options.headers, undefined);
  assert.equal(upload.options.followRedirects, false);
  assert.equal(f.properties.get("SVL_WINDOW_END"), undefined);
  assert.notEqual(f.properties.get("SVL_CURSOR"), "1789560000");
  assert.ok(f.calls.some((c) => c.url?.endsWith("/process")));
});
