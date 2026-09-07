import { actorMayAccessManagerOps } from "@svl/domain";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getActorFromCookies } from "@/lib/auth/guards";
import { ManagerDashboard } from "./manager/dashboard";
import styles from "./page.module.css";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActorFromCookies();
  if (!actor) {
    redirect("/login");
  }

  if (!actorMayAccessManagerOps(actor) || (actor.role !== "admin" && actor.role !== "manager"))
    return (
      <div className={styles.page}>
        <main className={styles.main}>
          <div className={styles.intro}>
            <h1>Manager access required</h1>
            <p>
              This workspace is available to managers and administrators. Use the mobile app to
              submit and track your receipts, or contact your administrator about access.
            </p>
            <SignOutButton />
          </div>
        </main>
      </div>
    );

  return (
    <Suspense
      fallback={
        <div className={styles.page}>
          <p role="status">Opening your receipt workspace…</p>
        </div>
      }
    >
      <ManagerDashboard actorRole={actor.role} />
    </Suspense>
  );
}
