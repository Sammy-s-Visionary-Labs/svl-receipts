import { redirect } from "next/navigation";
import { getActorFromCookies } from "@/lib/auth/guards";
import { Icon } from "../manager/icons";
import styles from "../manager/manager.module.css";
import { ManagerShell } from "../manager/shell";
import teamStyles from "./team.module.css";
import { TeamAccounts } from "./team-accounts";
export const dynamic = "force-dynamic";
export default async function TeamPage() {
  const actor = await getActorFromCookies();
  if (!actor) redirect("/login");
  if (actor.role === "worker") redirect("/field");
  return (
    <ManagerShell actorRole={actor.role} active="team">
      <main id="main-content" className={styles.main}>
        <header className={teamStyles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>WORKSPACE ACCESS</p>
            <h1 className={styles.heading}>Team</h1>
            <p className={styles.subtitle}>
              Review new requests and manage {actor.role === "admin" ? "team" : "worker"} access.
            </p>
          </div>
          <a
            className={teamStyles.signupButton}
            href="/request-access"
            target="_blank"
            rel="noreferrer"
          >
            Worker signup <Icon name="external" size={16} />
          </a>
        </header>
        <TeamAccounts actorId={actor.userId} admin={actor.role === "admin"} />
      </main>
    </ManagerShell>
  );
}
