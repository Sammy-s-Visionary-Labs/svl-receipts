import { Suspense } from "react";
import { Icon } from "../field/glyph";
import styles from "./login.module.css";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  const isWorkerPreview =
    process.env.VERCEL_ENV === "preview" && process.env.VERCEL_GIT_COMMIT_REF === "worker-web-app";
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
          {isWorkerPreview ? (
            <p>
              <strong>Development preview.</strong> Use your development account. Production
              accounts and receipts are separate from this test website.
            </p>
          ) : (
            <p>
              Use your SVL Receipts account. Your receipts and office workspace are ready when you
              are.
            </p>
          )}
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
        <p className={styles.help}>Need an account or help signing in? Contact your manager.</p>
      </main>
    </div>
  );
}
