/** A manager's manual resolution attestation, not provider-verified posting evidence. */
export type LaborManualCorrection = {
  id: string;
  approvalId: string;
  snapshotHash: string;
  recordedBy: string;
  recordedAt: string;
  reason: string;
  providerReference: string;
  evidence: string;
};
