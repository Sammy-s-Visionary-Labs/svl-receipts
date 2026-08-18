/**
 * Shared business vocabulary for SVL Receipts.
 * UI frameworks and vendor SDKs do not belong here.
 *
 * @see docs/domain-contracts.md
 */

export const DOMAIN_PACKAGE = "@svl/domain" as const;

export * from "./audit";
export * from "./authz";
export * from "./extraction";
export * from "./housecall";
export * from "./legacy-status";
export * from "./money";
export * from "./outbox";
export * from "./receipt-status";
export * from "./retention";
export * from "./review";
export * from "./roles";
export * from "./storage-errors";
export * from "./transitions";
export * from "./upload";
export * from "./work";
