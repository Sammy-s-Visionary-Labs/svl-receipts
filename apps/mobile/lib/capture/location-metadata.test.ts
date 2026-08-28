import { describe, expect, it } from "vitest";
import { locationMetadataFromSnapshot } from "./location-metadata";

describe("locationMetadataFromSnapshot", () => {
  it("stores only the point-in-time fields in the RA-102 contract", () => {
    expect(
      locationMetadataFromSnapshot({
        coords: { latitude: 40.7128, longitude: -74.006, accuracy: 18.4 },
        timestamp: Date.UTC(2026, 7, 21, 12, 30),
      }),
    ).toEqual({
      latitude: 40.7128,
      longitude: -74.006,
      accuracyMeters: 18.4,
      capturedAt: "2026-08-21T12:30:00.000Z",
    });
  });

  it("keeps unavailable values nullable", () => {
    expect(
      locationMetadataFromSnapshot({
        coords: { latitude: Number.NaN, longitude: Number.NaN, accuracy: null },
        timestamp: Number.NaN,
      }),
    ).toEqual({
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      capturedAt: null,
    });
  });
});
