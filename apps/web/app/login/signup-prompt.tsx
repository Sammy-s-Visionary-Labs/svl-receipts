import Link from "next/link";
import styles from "./login.module.css";

export function SignupPrompt() {
  return (
    <section className={styles.signup} aria-labelledby="signup-title">
      <h2 id="signup-title">New to SVL Receipts?</h2>
      <p>Set up your account. Your manager will approve access before you can send receipts.</p>
      <Link className={styles.signupAction} href="/request-access">
        Create account
      </Link>
    </section>
  );
}
