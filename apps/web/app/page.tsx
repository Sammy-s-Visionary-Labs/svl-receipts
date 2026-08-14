import { DOMAIN_PACKAGE } from "@svl/domain";
import { INTEGRATIONS_PACKAGE } from "@svl/integrations";
import { redirect } from "next/navigation";
import { getActorFromCookies } from "@/lib/auth/guards";
import styles from "./page.module.css";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActorFromCookies();
  if (!actor) {
    redirect("/login");
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>SVL Receipts — Manager web</h1>
          <p>
            Signed in as <code>{actor.role}</code>. Role is loaded from the server profile, not the
            browser. Scaffold: <code>{DOMAIN_PACKAGE}</code>, <code>{INTEGRATIONS_PACKAGE}</code>.
          </p>
          <SignOutButton />
        </div>
      </main>
    </div>
  );
}
