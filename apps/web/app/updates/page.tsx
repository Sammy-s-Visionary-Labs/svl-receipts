import { actorMayAccessManagerOps } from "@svl/domain";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getActorFromCookies } from "@/lib/auth/guards";
import { laborFeatureEnabled } from "@/lib/labor/config";
import layout from "../manager/manager.module.css";
import { ManagerShell } from "../manager/shell";
import { releaseWeeks } from "./releases";
import styles from "./updates.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Updates | SVL Receipts" };

export default async function UpdatesPage() {
  const actor = await getActorFromCookies();
  if (!actor) redirect("/login");
  if (actor.role === "worker") redirect("/field");
  if (!actorMayAccessManagerOps(actor)) redirect("/login");

  return (
    <ManagerShell actorRole={actor.role} laborEnabled={laborFeatureEnabled()} active="updates">
      <main id="main-content" className={`${layout.main} ${styles.main}`}>
        <header className={styles.heading}>
          <h1 className={layout.heading}>Updates</h1>
          <p className={layout.subtitle}>What changed in the receipt app.</p>
        </header>
        {releaseWeeks.map((week) => (
          <section
            key={week.weekOf}
            className={styles.week}
            aria-labelledby={`week-${week.weekOf}`}
          >
            <h2 id={`week-${week.weekOf}`} className={styles.weekHeading}>
              {week.label}
            </h2>
            <div className={styles.log}>
              {week.days.map((day) => (
                <section key={day.date} className={styles.day} aria-labelledby={`day-${day.date}`}>
                  <h3 id={`day-${day.date}`} className={styles.date}>
                    <time dateTime={day.date}>{day.label}</time>
                  </h3>
                  <ul className={styles.changes}>
                    {day.changes.map((change) => (
                      <li key={change.text}>
                        <span className={styles.kind} data-kind={change.kind}>
                          {change.kind}
                        </span>
                        <p>{change.text}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
        ))}
      </main>
    </ManagerShell>
  );
}
