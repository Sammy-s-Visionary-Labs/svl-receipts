import assert from "node:assert/strict";
import test from "node:test";
import { decryptSession, encryptSession, MAX_SESSION_BYTES, sessionKey } from "./session.mjs";

export const fixtureState = {
  cookies: [
    {
      name: "fixture-auth",
      value: "SYNTHETIC-NOT-A-LOGIN",
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
      indexedDB: [{ name: "fixture-db", version: 1, stores: [] }],
    },
  ],
};
const key = "a1".repeat(32);

test("portable cookies, local storage and IndexedDB round-trip only inside authenticated encryption", () => {
  const first = encryptSession(fixtureState, key, "2026-10-13T12:00:00Z");
  const second = encryptSession(fixtureState, key, "2026-10-13T12:00:00Z");
  assert.notDeepEqual(first, second, "each save gets a fresh random nonce");
  assert.equal(first.includes(Buffer.from("SYNTHETIC-NOT-A-LOGIN")), false);
  assert.deepEqual(decryptSession(first, key), fixtureState);
});

test("wrong keys and modifications to ciphertext, nonce or tag fail without disclosing authentication", () => {
  const encrypted = encryptSession(fixtureState, key);
  assert.throws(() => decryptSession(encrypted, "b2".repeat(32)), /authentication failed/);
  for (const index of [12, 26, encrypted.length - 1]) {
    const changed = Buffer.from(encrypted);
    changed[index] ^= 1;
    assert.throws(() => decryptSession(changed, key), /authentication failed/);
  }
  assert.throws(() => decryptSession(Buffer.from("plain session"), key), /Unsupported encrypted/);
});

test("session key, size and shape guards reject misconfiguration and unrelated data", () => {
  for (const invalid of [undefined, "secret", "g".repeat(64), "a".repeat(63)])
    assert.throws(() => sessionKey(invalid), /private 32-byte key/);
  assert.throws(
    () => encryptSession({ cookies: [], origins: [], otherBrowserState: true }, key),
    /Unsupported portable/,
  );
  assert.throws(
    () =>
      encryptSession(
        { cookies: [], origins: [{ origin: "http://example.test", localStorage: [] }] },
        key,
      ),
    /Invalid portable/,
  );
  assert.throws(
    () =>
      encryptSession(
        {
          cookies: [],
          origins: [
            {
              origin: "https://example.test",
              localStorage: [{ name: "large", value: "x".repeat(MAX_SESSION_BYTES) }],
            },
          ],
        },
        key,
      ),
    /storage limit/,
  );
  assert.throws(
    () => decryptSession(Buffer.alloc(MAX_SESSION_BYTES + 1), key),
    /Unsupported encrypted/,
  );
});
