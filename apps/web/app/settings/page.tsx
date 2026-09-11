import { actorMayAccessAdminOps } from "@svl/domain";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActorFromCookies } from "@/lib/auth/guards";
import { Icon } from "../manager/icons";
import styles from "../manager/manager.module.css";
import { ManagerShell } from "../manager/shell";
import { CategorySettings } from "./categories";
import { HousecallSettings } from "./housecall";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const actor = await getActorFromCookies();
  if (!actor) redirect("/login");
  if (!actorMayAccessAdminOps(actor)) redirect("/");
  return (
    <ManagerShell actorRole="admin" active="settings">
      <main id="main-content" className={styles.main}>
        <p className={styles.eyebrow}>ADMINISTRATION</p>
        <h1 className={styles.heading}>Workspace settings</h1>
        <p className={styles.subtitle}>Your account and workspace access.</p>
        <section className={styles.settingsCard} aria-labelledby="access-heading">
          <span className={styles.sectionIcon}>
            <Icon name="settings" />
          </span>
          <h2 id="access-heading">Account access</h2>
          <p>Administrators can access the manager inbox, receipt history, and settings.</p>
          <dl className={styles.detailGrid}>
            <div>
              <dt>Role</dt>
              <dd>Administrator</dd>
            </div>
            <div>
              <dt>Account status</dt>
              <dd>Active</dd>
            </div>
            <div>
              <dt>Account ID</dt>
              <dd className={styles.monospace}>{actor.userId}</dd>
            </div>
          </dl>
          <p className={styles.settingsNote}>
            User and integration settings are managed by your workspace administrator.
          </p>
          <Link href="/" className={styles.primaryButton}>
            Return to inbox <Icon name="arrow" size={16} />
          </Link>
        </section>
        <CategorySettings />
        <HousecallSettings />
      </main>
    </ManagerShell>
  );
}
