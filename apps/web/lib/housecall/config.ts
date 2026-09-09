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
  return {
    readsEnabled,
    exportsEnabled: readsEnabled && env.HOUSECALL_EXPORT_MODE === "approved_test" && validIds,
    allowedJobIds: new Set(validIds ? ids : []),
    configured: !!env.HOUSECALL_API_KEY?.trim(),
    mode:
      env.HOUSECALL_EXPORT_MODE === "approved_test"
        ? ("approved_test" as const)
        : ("disabled" as const),
  };
}
