import type { ReceiptLocationMetadata } from "./receipt-pages";

export type LocationSnapshotInput = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
  timestamp: number;
};

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function locationMetadataFromSnapshot(
  snapshot: LocationSnapshotInput,
): ReceiptLocationMetadata {
  return {
    latitude: finiteOrNull(snapshot.coords.latitude),
    longitude: finiteOrNull(snapshot.coords.longitude),
    accuracyMeters: finiteOrNull(snapshot.coords.accuracy),
    capturedAt: Number.isFinite(snapshot.timestamp)
      ? new Date(snapshot.timestamp).toISOString()
      : null,
  };
}
