/** Optional repository-scoped Actions credential; never reuse a developer's personal login. */
export async function dispatchLaborWorker(): Promise<{ dispatched: boolean; message: string }> {
  const token = process.env.LABOR_GITHUB_DISPATCH_TOKEN;
  if (!token)
    return {
      dispatched: false,
      message:
        "Download request saved. No immediate worker trigger is configured. A running worker must check for the queued request.",
    };
  const repository = process.env.LABOR_GITHUB_REPOSITORY;
  const ref = process.env.LABOR_GITHUB_REF ?? "master";
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9_./-]{1,160}$/.test(ref)
  )
    return {
      dispatched: false,
      message:
        "Download request saved. The immediate worker trigger needs configuration. A running worker must check for the queued request.",
    };
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/workflows/supercrew-labor.yml/dispatches`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref }),
      },
    );
    if (response.status === 204)
      return {
        dispatched: true,
        message:
          "Download request saved. Worker launch requested; import history updates after the worker verifies both reports.",
      };
  } catch {
    /* Keep the durable command for a configured worker to claim. */
  }
  return {
    dispatched: false,
    message:
      "Download request saved. The immediate worker trigger is unavailable. A running worker must check for the queued request.",
  };
}
