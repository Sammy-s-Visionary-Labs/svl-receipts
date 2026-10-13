import { getLaborPageActor } from "@/lib/labor/access";
import { laborFeatureEnabled } from "@/lib/labor/config";
import { ManagerShell } from "../manager/shell";
import { JobsDashboard } from "./jobs-dashboard";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const actor = await getLaborPageActor();
  return (
    <ManagerShell actorRole={actor.role} laborEnabled={laborFeatureEnabled()} active="jobs">
      <JobsDashboard />
    </ManagerShell>
  );
}
