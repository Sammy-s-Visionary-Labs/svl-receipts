"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./team.module.css";

type Account = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  role: "worker" | "manager" | "admin";
  disabled: boolean;
  access_status: string;
  access_version: number;
  created_at: string;
};
export function TeamAccounts({ actorId, admin }: { actorId: string; admin: boolean }) {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(0);
  const [users, setUsers] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/manager/users?status=${status}&page=${page}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not load accounts.");
      if (current === sequence.current) {
        setUsers(data.users);
        setTotal(data.total);
      }
    } catch (cause) {
      if (current === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not load accounts.");
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [status, page]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  async function change(user: Account, action: string, role?: string) {
    const label = user.full_name || user.email;
    const explanation =
      action === "approve"
        ? `Approve ${label}? Confirm that you recognize this worker and their email address. They will be able to send receipts.`
        : action === "role"
          ? `Change ${label} to ${role}? This changes their workspace permissions immediately.`
          : `${action[0].toUpperCase()}${action.slice(1)} access for ${label}?`;
    if (!window.confirm(explanation)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/manager/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, action, version: user.access_version, role }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not change this account.");
      setNotice(`Access updated for ${label}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change this account.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="Team accounts">
      <div className={styles.toolbar}>
        <label>
          Show
          <select
            value={status}
            disabled={busy}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
              setNotice("");
            }}
          >
            <option value="pending">Access requests</option>
            <option value="approved">Approved accounts</option>
            <option value="rejected">Rejected requests</option>
          </select>
        </label>
        <button type="button" onClick={() => void load()} disabled={loading || busy}>
          Refresh
        </button>
        <a href="/request-access" target="_blank" rel="noreferrer">
          Open worker signup
        </a>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading accounts…</p>
      ) : !users.length ? (
        <p>No {status === "pending" ? "access requests" : "accounts"} to show.</p>
      ) : (
        <ul className={styles.list}>
          {users.map((user) => (
            <li key={user.id} className={styles.person}>
              <div>
                <h2>{user.full_name || user.email || "Team member"}</h2>
                <p>
                  {user.email}
                  {user.phone ? ` · ${user.phone}` : ""}
                </p>
                <p>
                  {user.role} ·{" "}
                  {user.access_status === "approved"
                    ? user.disabled
                      ? "Disabled"
                      : "Active"
                    : user.access_status}{" "}
                  · Joined {new Date(user.created_at).toLocaleDateString()}
                </p>
              </div>
              <div className={styles.actions}>
                {user.access_status === "pending" && (
                  <>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy}
                      onClick={() => void change(user, "approve")}
                    >
                      Approve request
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void change(user, "reject")}
                    >
                      Reject request
                    </button>
                  </>
                )}
                {user.access_status === "approved" && user.id !== actorId && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void change(user, user.disabled ? "enable" : "disable")}
                    >
                      {user.disabled ? "Enable account" : "Disable account"}
                    </button>
                    {admin && (
                      <label>
                        Role for {user.full_name || user.email}
                        <select
                          value={user.role}
                          disabled={busy}
                          onChange={(e) => void change(user, "role", e.target.value)}
                        >
                          <option value="worker">Worker</option>
                          <option value="manager">Manager</option>
                          <option value="admin">Admin</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                {user.id === actorId && <span>Your account</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.toolbar}>
        <button
          type="button"
          disabled={page === 0 || loading || busy}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>
          Page {page + 1} · {total} accounts
        </span>
        <button
          type="button"
          disabled={(page + 1) * 50 >= total || loading || busy}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}
