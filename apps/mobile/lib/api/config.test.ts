import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./config";

describe("resolveApiBaseUrl", () => {
  it("prefers EXPO_PUBLIC_API_URL", () => {
    expect(
      resolveApiBaseUrl({
        envUrl: "https://preview.example.com/",
        hostUri: "192.168.1.2:8081",
      }),
    ).toBe("https://preview.example.com");
  });

  it("uses the Expo packager host so a phone can reach the laptop API", () => {
    expect(resolveApiBaseUrl({ hostUri: "192.168.1.20:8081" })).toBe("http://192.168.1.20:3000");
  });

  it("falls back to localhost", () => {
    expect(resolveApiBaseUrl({})).toBe("http://localhost:3000");
  });
});
