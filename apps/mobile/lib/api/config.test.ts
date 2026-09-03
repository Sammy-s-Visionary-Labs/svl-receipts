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

  it("maps a loopback override to the Android emulator host bridge", () => {
    expect(
      resolveApiBaseUrl({
        envUrl: "http://127.0.0.1:3000",
        hostUri: "127.0.0.1:8081",
        platform: "android",
        isDevice: false,
      }),
    ).toBe("http://10.0.2.2:3000");
  });

  it("ignores a loopback override on a physical phone and uses the packager LAN host", () => {
    expect(
      resolveApiBaseUrl({
        envUrl: "http://127.0.0.1:3000",
        hostUri: "192.168.1.20:8081",
        platform: "android",
        isDevice: true,
      }),
    ).toBe("http://192.168.1.20:3000");
  });

  it("never points a standalone physical phone at its own localhost", () => {
    expect(() =>
      resolveApiBaseUrl({
        envUrl: "http://127.0.0.1:3000",
        hostUri: null,
        platform: "android",
        isDevice: true,
      }),
    ).toThrow("physical_device_api_url_required");
  });
});
