"use client";
import { type FormEvent, useState } from "react";
import styles from "../login/login.module.css";
export function RequestAccessForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (fields.get("password") !== fields.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: fields.get("fullName"),
          email: fields.get("email"),
          phone: fields.get("phone"),
          password: fields.get("password"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not send your request.");
      form.reset();
      setMessage(data.message);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send your request. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (message) return <p role="status">{message}</p>;
  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <label className={styles.label}>
        Full name
        <input
          className={styles.input}
          name="fullName"
          autoComplete="name"
          minLength={2}
          maxLength={120}
          required
        />
      </label>
      <label className={styles.label}>
        Email
        <input
          className={styles.input}
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
        />
      </label>
      <label className={styles.label}>
        Phone (optional)
        <input className={styles.input} name="phone" type="tel" autoComplete="tel" maxLength={40} />
      </label>
      <div className={styles.label}>
        <label htmlFor="new-worker-password">Password</label>
        <input
          id="new-worker-password"
          aria-describedby="new-worker-password-help"
          className={styles.input}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <small id="new-worker-password-help">At least 12 characters.</small>
      </div>
      <label className={styles.label}>
        Confirm password
        <input
          className={styles.input}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button className={styles.submit} type="submit" disabled={busy}>
        {busy ? "Sending request…" : "Request access"}
      </button>
    </form>
  );
}
