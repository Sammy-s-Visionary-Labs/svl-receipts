import { Suspense } from "react";
import { Icon } from "../field/glyph";
import styles from "./login.module.css";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>
          <span>
            <Icon name="receipt" size={26} />
          </span>
          SVL Receipts
        </div>
        <div className={styles.intro}>
          <h1>Sign in</h1>
          <p>Sign in to manage your receipts.</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
        <p className={styles.help}>Need an account or help signing in? Contact your manager.</p>
      </main>
    </div>
  );
}
