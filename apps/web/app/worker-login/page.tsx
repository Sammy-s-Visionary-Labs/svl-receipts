import Link from "next/link";
import { Suspense } from "react";
import styles from "../login/login.module.css";
import { LoginForm } from "../login/login-form";
export default function WorkerLoginPage() {
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>SVL Receipts</div>
        <div className={styles.intro}>
          <h1>Worker sign in</h1>
          <p>Capture receipts and follow their progress.</p>
        </div>
        <Suspense>
          <LoginForm defaultNext="/field" />
        </Suspense>
        <p className={styles.help}>
          First time here? <Link href="/request-access">Request worker access</Link>
        </p>
        <p className={styles.help}>
          <Link href="/login">Manager sign in</Link>
        </p>
      </main>
    </div>
  );
}
