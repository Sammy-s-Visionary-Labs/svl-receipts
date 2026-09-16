import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import styles from "../login/login.module.css";
import { SignOutButton } from "../sign-out-button";
export const dynamic = "force-dynamic";
export default async function AccessStatusPage() {
  const db = await createServerSupabaseClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/worker-login");
  const { data } = await db
    .from("profiles")
    .select("disabled,access_status,role")
    .eq("id", user.id)
    .maybeSingle();
  if (data && !data.disabled && data.access_status === "approved")
    redirect(data.role === "worker" ? "/field" : "/");
  const pending = data?.access_status === "pending";
  const rejected = data?.access_status === "rejected";
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>SVL Receipts</div>
        <div className={styles.intro}>
          <h1>
            {pending
              ? "Waiting for approval"
              : rejected
                ? "Request not approved"
                : "Account unavailable"}
          </h1>
          <p>
            {pending
              ? "Your manager has received your request. Once approved, you can sign in with your email and password and start sending receipts."
              : rejected
                ? "Your request was declined. Contact your manager if you think this is a mistake."
                : "This account is disabled or its access could not be checked. Contact your manager for help."}
          </p>
        </div>
        <p>
          <Link href="/access-status">Check again</Link>
        </p>
        <SignOutButton />
      </main>
    </div>
  );
}
