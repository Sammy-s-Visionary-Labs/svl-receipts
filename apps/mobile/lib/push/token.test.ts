import { describe, expect, it } from "vitest";
import { isExpoPushToken } from "./token";

describe("isExpoPushToken", () => {
  it("accepts every Expo token form used by the server SDK", () => {
    expect(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("F5741A13-BCDA-434B-A316-5DC0E6FFA94F")).toBe(true);
  });

  it("rejects other strings", () => {
    expect(isExpoPushToken("not-a-token")).toBe(false);
  });
});
