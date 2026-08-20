import { describe, expect, it } from "vitest";
import { isExpoPushToken } from "./push-token";

describe("isExpoPushToken", () => {
  it("accepts every token form supported by Expo", () => {
    expect(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("F5741A13-BCDA-434B-A316-5DC0E6FFA94F")).toBe(true);
  });

  it("rejects non-Expo tokens", () => {
    expect(isExpoPushToken("ExponentPushToken-without-brackets")).toBe(false);
    expect(isExpoPushToken("not-a-token")).toBe(false);
  });
});
