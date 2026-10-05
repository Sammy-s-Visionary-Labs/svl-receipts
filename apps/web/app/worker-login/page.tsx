import Link from "next/link";
import { Suspense } from "react";
import styles from "../login/login.module.css";
import { LoginForm } from "../login/login-form";
import { SignupPrompt } from "../login/signup-prompt";
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
        <SignupPrompt />
        <p className={styles.help}>
          <Link href="/login">Manager sign in</Link>
        </p>
      </main>
    </div>
  );
}
