import { describe, expect, it } from "vitest";
import {
  canonicalReceiptUploadId,
  createReceiptUploadServerMetric,
  parseReceiptUploadTelemetryEvent,
  RECEIPT_UPLOAD_EVENTS,
  RECEIPT_UPLOAD_SERVER_EVENTS,
} from "./upload-telemetry";

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

describe("receipt upload telemetry", () => {
  it("canonicalizes UUID correlation ids and rejects free-form route values", () => {
    expect(canonicalReceiptUploadId(RECEIPT_ID.toUpperCase())).toBe(RECEIPT_ID);
    expect(canonicalReceiptUploadId("not-a-receipt-id\nattacker-controlled-log-text")).toBeNull();
    expect(canonicalReceiptUploadId("11111111-1111-1111-1111-111111111111")).toBeNull();
    expect(
      createReceiptUploadServerMetric({
        event: "confirmation_api_failed",
        receiptId: "not-a-receipt-id\nattacker-controlled-log-text",
        pageCount: 0,
        durationMs: 1,
        result: "failure",
      }),
    ).toBeNull();
  });

  it("keeps only reporting-safe fields", () => {
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "submission_failed",
        receiptId: RECEIPT_ID,
        pageCount: 2,
        occurredAt: "2026-08-21T12:00:00.000Z",
        durationMs: 825,
        result: "failure",
        failureCategory: "network",
        image: "base64-secret",
        ocrText: "receipt contents",
        latitude: 39.9,
        longitude: -83.0,
        token: "signed-secret",
        error: "Authorization: Bearer secret",
      }),
    ).toEqual({
      source: "mobile",
      event: "submission_failed",
      receiptId: RECEIPT_ID,
      pageCount: 2,
      occurredAt: "2026-08-21T12:00:00.000Z",
      durationMs: 825,
      result: "failure",
      failureCategory: "network",
    });
  });

  it("keeps mobile lifecycle and server request metrics disjoint", () => {
    expect(
      RECEIPT_UPLOAD_SERVER_EVENTS.filter((event) =>
        (RECEIPT_UPLOAD_EVENTS as readonly string[]).includes(event),
      ),
    ).toEqual([]);
    expect(
      createReceiptUploadServerMetric({
        event: "confirmation_api_completed",
        receiptId: RECEIPT_ID,
        pageCount: 2,
        durationMs: 125,
        result: "success",
      }),
    ).toEqual({
      source: "server",
      event: "confirmation_api_completed",
      receiptId: RECEIPT_ID,
      pageCount: 2,
      durationMs: 125,
      result: "success",
    });
  });

  it("labels accepted reports as mobile even if the caller supplies another source", () => {
    expect(
      parseReceiptUploadTelemetryEvent({
        source: "server",
        event: "session_created",
        receiptId: RECEIPT_ID,
        pageCount: 1,
        occurredAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toMatchObject({ source: "mobile", event: "session_created" });
  });

  it("canonicalizes accepted client receipt ids before logging", () => {
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "session_created",
        receiptId: RECEIPT_ID.toUpperCase(),
        pageCount: 1,
        occurredAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toMatchObject({ receiptId: RECEIPT_ID });
  });

  it("rejects uncorrelated or out-of-range events", () => {
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "session_created",
        receiptId: "not-a-uuid",
        pageCount: 1,
        occurredAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "page_upload_completed",
        receiptId: RECEIPT_ID,
        pageCount: 6,
        occurredAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("rejects secret-bearing date comments instead of retaining free-form timestamp text", () => {
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "submission_failed",
        receiptId: RECEIPT_ID,
        pageCount: 1,
        occurredAt: "Fri, 21 Aug 2026 12:00:00 GMT (Authorization Bearer TOPSECRET)",
      }),
    ).toBeNull();
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "submission_failed",
        receiptId: RECEIPT_ID,
        pageCount: 1,
        occurredAt: "2026-02-31T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parseReceiptUploadTelemetryEvent({
        event: "submission_failed",
        receiptId: RECEIPT_ID,
        pageCount: 1,
        occurredAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toMatchObject({ occurredAt: "2026-08-21T12:00:00.000Z" });
  });
});
