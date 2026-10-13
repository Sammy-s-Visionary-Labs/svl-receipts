import { getLaborPageActor } from "@/lib/labor/access";
import { laborFeatureEnabled } from "@/lib/labor/config";
import { ManagerShell } from "../manager/shell";
import { LaborDashboard } from "./labor-dashboard";

export const dynamic = "force-dynamic";

export default async function LaborHoursPage() {
  const actor = await getLaborPageActor();
  return (
    <ManagerShell actorRole={actor.role} laborEnabled={laborFeatureEnabled()} active="labor-hours">
      <LaborDashboard />
    </ManagerShell>
  );
}
