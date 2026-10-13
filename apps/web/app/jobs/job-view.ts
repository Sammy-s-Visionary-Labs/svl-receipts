import type { LaborEntryAllocation } from "@svl/domain";
import type { JobActivity } from "@/lib/labor/contract";

/** Old source links remain useful only when their imported ranges share one destination. */
export function resolveJobSelection(
  jobs: readonly JobActivity[],
  entries: readonly LaborEntryAllocation[],
  key: string,
) {
  const direct = jobs.find((job) => job.key === key);
  if (direct) return { job: direct, ambiguous: false };
  const keys = new Set(
    entries
      .filter(
        (entry) => entry.status === "allocated" && entry.destinationSourceKey === key && entry.job,
      )
      .map((entry) => entry.job?.key),
  );
  if (keys.size !== 1) return { job: undefined, ambiguous: keys.size > 1 };
  return { job: jobs.find((job) => keys.has(job.key)), ambiguous: false };
}
