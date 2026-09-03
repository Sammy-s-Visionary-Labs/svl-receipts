export type ConfirmationReplayInput = {
  id: string;
  status: string;
  submittedAt: string | null;
  checksumsMatch: boolean;
};

export function committedConfirmationReplay(input: ConfirmationReplayInput): {
  id: string;
  status: "submitted";
  submittedAt: string;
} | null {
  if (input.status === "upload_pending" || !input.submittedAt || !input.checksumsMatch) {
    return null;
  }
  return { id: input.id, status: "submitted", submittedAt: input.submittedAt };
}
