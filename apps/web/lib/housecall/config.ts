import { createHousecallClient } from "@svl/integrations";
/** No browser input can change these server-only operational controls. */
export function housecallConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const ids = (env.HOUSECALL_TEST_JOB_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const validIds =
    ids.length > 0 && ids.length <= 20 && ids.every((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id));
  const readsEnabled = env.HOUSECALL_READS_ENABLED === "true";
  const customerIds = [
    ...new Set(
      (env.HOUSECALL_TEST_CUSTOMER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort();
  const validCustomerScope =
    customerIds.length <= 20 && customerIds.every((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id));
  const allJobs = env.HOUSECALL_ACCESS_MODE === "all_jobs";
  const managerApproved = env.HOUSECALL_EXPORT_MODE === "manager_approved";
  return {
    allJobs,
    readsEnabled: readsEnabled && (allJobs || validCustomerScope),
    exportsEnabled:
      readsEnabled &&
      ((allJobs && managerApproved) ||
        (!allJobs &&
          validCustomerScope &&
          env.HOUSECALL_EXPORT_MODE === "approved_test" &&
          validIds)),
    allowedCustomerIds: allJobs ? [] : customerIds,
    allowedJobIds: new Set(validIds ? ids : []),
    configured: !!env.HOUSECALL_API_KEY?.trim(),
    mode: managerApproved
      ? ("manager_approved" as const)
      : env.HOUSECALL_EXPORT_MODE === "approved_test"
        ? ("approved_test" as const)
        : ("disabled" as const),
  };
}

export function configuredHousecallClient(
  timeoutMs = 15_000,
  correlationId?: string,
  approvedJobIds: readonly string[] = [],
) {
  const config = housecallConfiguration();
  return createHousecallClient({
    apiKey: process.env.HOUSECALL_API_KEY ?? "",
    timeoutMs,
    ...(correlationId ? { correlationId } : {}),
    // All-job access never means unrestricted writes: the caller must supply
    // the immutable receipt destinations and every request still needs a permit.
    allowedWriteJobIds: config.exportsEnabled
      ? config.allJobs
        ? [...approvedJobIds]
        : [...config.allowedJobIds]
      : [],
    ...(config.readsEnabled && config.allJobs
      ? {}
      : {
          allowedReadCustomerIds: config.readsEnabled ? config.allowedCustomerIds : [],
          allowedReadJobIds: config.readsEnabled ? [...config.allowedJobIds] : [],
        }),
  });
}
