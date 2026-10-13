import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const MAX_SESSION_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("SVLSESSION1\n");
const COMPANY = "Sammy’s Visionary Landscape";
const AAD = Buffer.from("svl-supercrew-session-v1");

export function sessionKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error(
      "LABOR_SESSION_ENCRYPTION_KEY must be a private 32-byte key encoded as 64 hex characters.",
    );
  return Buffer.from(value, "hex");
}

export function validatePortableState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.cookies) ||
    !Array.isArray(value.origins) ||
    Object.keys(value).some((key) => !["cookies", "origins"].includes(key))
  )
    throw new Error(
      "Unsupported portable Supercrew authentication state; reconnect the isolated session.",
    );
  for (const cookie of value.cookies) {
    if (
      !cookie ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      typeof cookie.path !== "string" ||
      typeof cookie.expires !== "number" ||
      !Number.isFinite(cookie.expires) ||
      typeof cookie.httpOnly !== "boolean" ||
      typeof cookie.secure !== "boolean" ||
      !["Strict", "Lax", "None"].includes(cookie.sameSite)
    )
      throw new Error("Invalid portable authentication cookie; reconnect the isolated session.");
  }
  for (const origin of value.origins) {
    let url;
    try {
      url = new URL(origin?.origin);
    } catch {
      throw new Error("Invalid portable authentication origin; reconnect the isolated session.");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== origin.origin ||
      !Array.isArray(origin.localStorage) ||
      origin.localStorage.some(
        (item) => typeof item?.name !== "string" || typeof item?.value !== "string",
      ) ||
      (origin.indexedDB !== undefined && !Array.isArray(origin.indexedDB))
    )
      throw new Error("Invalid portable authentication origin; reconnect the isolated session.");
  }
  return value;
}

export function encryptSession(storageState, encryptionKey, capturedAt = new Date().toISOString()) {
  const key = sessionKey(encryptionKey);
  validatePortableState(storageState);
  if (!Number.isFinite(Date.parse(capturedAt)))
    throw new Error("Invalid session capture timestamp.");
  const plaintext = Buffer.from(
    JSON.stringify({ version: 1, company: COMPANY, capturedAt, storageState }),
  );
  if (plaintext.length + MAGIC.length + 28 > MAX_SESSION_BYTES)
    throw new Error("Portable Supercrew session exceeds its private storage limit.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSession(bytes, encryptionKey) {
  const key = sessionKey(encryptionKey);
  const data = Buffer.from(bytes);
  if (
    data.length <= MAGIC.length + 28 ||
    data.length > MAX_SESSION_BYTES ||
    !data.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error(
      "Unsupported encrypted Supercrew session; reconnect using the configured session key.",
    );
  let parsed;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      data.subarray(MAGIC.length, MAGIC.length + 12),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(data.subarray(MAGIC.length + 12, MAGIC.length + 28));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(MAGIC.length + 28)),
      decipher.final(),
    ]);
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error(
      "Supercrew session authentication failed; check the private session key or reconnect.",
    );
  }
  if (
    parsed?.version !== 1 ||
    parsed.company !== COMPANY ||
    typeof parsed.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.capturedAt))
  )
    throw new Error("Unsupported portable Supercrew session version or company.");
  return validatePortableState(parsed.storageState);
}
