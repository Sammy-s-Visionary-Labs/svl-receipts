import { laborCatalogJobIsStale, matchLaborJobs } from "@svl/domain";
import { AuthHttpError } from "@/lib/auth/guards";
import { requireLaborAccess } from "@/lib/labor/access";
import { boundedJson, laborError, laborResponse } from "@/lib/labor/http";
import { loadLaborDashboard, updateLaborJobMappings } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { actor } = await requireLaborAccess(request);
    if (!actor) throw new AuthHttpError(403, "forbidden", "Manager access required.");
    const input = await boundedJson(request, 256 * 1024);
    if (!Array.isArray(input.mappings) || input.mappings.length > 500)
      throw new Error("Invalid job mappings.");
    const dashboard = await loadLaborDashboard();
    const catalog = dashboard.jobCatalog;
    const changed = input.mappings.filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid job mapping.");
      return !dashboard.jobMappings.some(
        (existing) =>
          existing.sourceKey === value.sourceKey &&
          existing.housecallJobId === value.housecallJobId &&
          existing.fromDate === value.fromDate &&
          existing.toDate === value.toDate &&
          existing.method === value.method,
      );
    });
    if (changed.length) {
      if (!catalog.complete || !catalog.fingerprint)
        throw new AuthHttpError(
          503,
          "catalog_unavailable",
          "A complete Housecall catalog is required before confirming job links.",
        );
      if (input.catalogFingerprint !== catalog.fingerprint)
        throw new Error("Stale Housecall catalog; reload before confirming job links.");
      const suggestions = matchLaborJobs(dashboard.mappingSources, catalog.jobs, {
        catalogComplete: true,
      });
      for (const value of changed) {
        const source = dashboard.mappingSources.find((item) => item.sourceKey === value.sourceKey);
        const job = catalog.jobs.find((item) => item.id === value.housecallJobId);
        if (source?.classification !== "customer")
          throw new Error("Only a reviewed customer location can be linked to Housecall.");
        if (!job?.customerId || job.unavailable || laborCatalogJobIsStale(job))
          throw new Error(
            "The selected Housecall job is missing, unavailable or stale. Refresh and review it.",
          );
        if (value.method === "exact_customer_address") {
          if (
            suggestions.find((item) => item.sourceKey === source.sourceKey)?.automaticJobId !==
            job.id
          )
            throw new Error(
              "This location does not have one exact customer-and-address match. Confirm the job manually.",
            );
        } else if (value.method !== "reviewed")
          throw new Error("Invalid job mapping confirmation method.");
      }
    }
    return laborResponse(
      await updateLaborJobMappings(
        input.mappings,
        input.expectedRevision,
        actor.userId,
        catalog.fingerprint ?? undefined,
      ),
    );
  } catch (error) {
    return laborError(error);
  }
}
