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
  return {
    readsEnabled: readsEnabled && validCustomerScope,
    exportsEnabled:
      readsEnabled &&
      validCustomerScope &&
      env.HOUSECALL_EXPORT_MODE === "approved_test" &&
      validIds,
    allowedCustomerIds: customerIds,
    allowedJobIds: new Set(validIds ? ids : []),
    configured: !!env.HOUSECALL_API_KEY?.trim(),
    mode:
      env.HOUSECALL_EXPORT_MODE === "approved_test"
        ? ("approved_test" as const)
        : ("disabled" as const),
  };
}

export function configuredHousecallClient(timeoutMs = 15_000, correlationId?: string) {
  const config = housecallConfiguration();
  return createHousecallClient({
    apiKey: process.env.HOUSECALL_API_KEY ?? "",
    timeoutMs,
    ...(correlationId ? { correlationId } : {}),
    allowedWriteJobIds: [...config.allowedJobIds],
    // The application supports scoped test operation only. Empty scopes deny
    // reads at the transport; toggling reads alone cannot scan the business.
    allowedReadCustomerIds: config.allowedCustomerIds,
    allowedReadJobIds: [...config.allowedJobIds],
  });
}
