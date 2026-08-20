import { describe, expect, it } from "vitest";
import { isExpoPushToken } from "./token";

describe("isExpoPushToken", () => {
  it("accepts Expo tokens and rejects other strings", () => {
    expect(isExpoPushToken("ExponentPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("not-a-token")).toBe(false);
  });
});
