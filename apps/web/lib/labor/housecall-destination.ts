/** Additional deployment confinement; it never enables the independent labor send flag. */
export const LABOR_HOUSECALL_TEST_JOB = "job_ba8e7f222367485dbb201f84fe83f9e6";

export function laborDestinationAllowed(
  env: Readonly<Record<string, string | undefined>>,
  jobId?: string,
): boolean {
  const configured = env.LABOR_HOUSECALL_ALLOWED_JOB_IDS;
  let allowlist: string[] | null = null;
  if (configured !== undefined) {
    allowlist = configured.split(",").map((id) => id.trim());
    if (allowlist.length > 100 || allowlist.some((id) => !/^[A-Za-z0-9_-]{1,160}$/.test(id)))
      return false;
  }
  // A mistyped test-mode setting fails closed instead of disabling confinement.
  const testMode = env.LABOR_HOUSECALL_TEST_MODE;
  if (testMode !== undefined && testMode !== "0" && testMode !== "1") return false;
  if (testMode === "1") {
    if (allowlist && !allowlist.includes(LABOR_HOUSECALL_TEST_JOB)) return false;
    return jobId === undefined || jobId === LABOR_HOUSECALL_TEST_JOB;
  }
  return jobId === undefined || allowlist === null || allowlist.includes(jobId);
}
