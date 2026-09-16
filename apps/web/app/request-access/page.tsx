import Link from "next/link";
import styles from "../login/login.module.css";
import { RequestAccessForm } from "./request-form";
export default function RequestAccessPage() {
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>SVL Receipts</div>
        <div className={styles.intro}>
          <h1>Request worker access</h1>
          <p>
            Create your sign-in details. Your manager must approve your request before you can send
            receipts.
          </p>
        </div>
        <RequestAccessForm />
        <p className={styles.help}>
          Already have an account? <Link href="/worker-login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
