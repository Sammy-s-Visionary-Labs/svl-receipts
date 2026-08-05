import { DOMAIN_PACKAGE } from "@svl/domain";
import { INTEGRATIONS_PACKAGE } from "@svl/integrations";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>SVL Receipts — Manager web</h1>
          <p>
            Scaffold check: linked to <code>{DOMAIN_PACKAGE}</code> and{" "}
            <code>{INTEGRATIONS_PACKAGE}</code>.
          </p>
        </div>
      </main>
    </div>
  );
}
