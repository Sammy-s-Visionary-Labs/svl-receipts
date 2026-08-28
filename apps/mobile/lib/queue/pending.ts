import { QUEUE_SIGN_OUT_POLICY } from "@svl/domain";

/** RA-24 owns the real queue. Until then there is nothing to warn about. */
export async function countQueuedReceipts(): Promise<number> {
  return 0;
}

export function shouldWarnOnSignOut(queuedCount: number): boolean {
  return QUEUE_SIGN_OUT_POLICY.warnWhenQueueNonEmpty && queuedCount > 0;
}
