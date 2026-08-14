import { Suspense } from "react";
import styles from "../page.module.css";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>Sign in</h1>
          <p>
            Use the account created for you in Supabase Auth. Roles come from the server profile,
            not this form.
          </p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </main>
    </div>
  );
}
