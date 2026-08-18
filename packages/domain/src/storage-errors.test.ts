import { describe, expect, it } from "vitest";
import { isReceiptStorageObjectAbsent } from "./storage-errors";

describe("receipt storage absence classifier", () => {
  it("treats NoSuchKey as the object being gone", () => {
    expect(isReceiptStorageObjectAbsent({ code: "NoSuchKey", message: "not found" })).toBe(true);
  });

  it("does not treat bucket or generic 404 failures as verified absence", () => {
    expect(isReceiptStorageObjectAbsent({ code: "NoSuchBucket", status: 404 })).toBe(false);
    expect(isReceiptStorageObjectAbsent({ status: 404, message: "Not Found" })).toBe(false);
    expect(isReceiptStorageObjectAbsent({ error: "not_found", message: "Bucket not found" })).toBe(
      false,
    );
  });

  it("accepts the legacy object-not-found shape only when the message is about the object", () => {
    expect(isReceiptStorageObjectAbsent({ error: "not_found", message: "Object not found" })).toBe(
      true,
    );
    expect(isReceiptStorageObjectAbsent({ error: "ObjectNotFound" })).toBe(true);
  });
});
