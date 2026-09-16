"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../manager/icons";
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
        if (page > 0 && page * 50 >= data.total) {
          setPage(Math.max(0, Math.ceil(data.total / 50) - 1));
          return;
        }
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
  const views = [
    { value: "pending", label: "Access requests" },
    { value: "approved", label: "Team members" },
    { value: "rejected", label: "Rejected" },
  ];
  const empty =
    status === "pending"
      ? {
          title: "You're all caught up",
          description: "New worker requests will appear here, ready for you to review.",
        }
      : status === "approved"
        ? {
            title: "No team members yet",
            description: "Approve a worker's access request to add them to your team.",
          }
        : {
            title: "No rejected requests",
            description: "Requests you decline will appear here for reference.",
          };
  return (
    <section className={styles.panel} aria-label="Team accounts">
      <div className={styles.toolbar}>
        <fieldset className={styles.views} aria-label="Account views">
          {views.map((view) => (
            <button
              type="button"
              key={view.value}
              aria-pressed={status === view.value}
              className={status === view.value ? styles.selectedView : undefined}
              disabled={busy}
              onClick={() => {
                setStatus(view.value);
                setPage(0);
                setNotice("");
              }}
            >
              {view.label}
              {status === view.value && !loading && <span className={styles.count}>{total}</span>}
            </button>
          ))}
        </fieldset>
        <button
          className={styles.refresh}
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
        >
          <Icon name="refresh" size={16} /> Refresh
        </button>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          <Icon name="check" size={16} />
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          <Icon name="warning" size={16} />
          {error}
        </p>
      )}
      {loading ? (
        <div className={styles.empty} role="status">
          <span className={styles.emptyIcon}>
            <Icon name="clock" size={24} />
          </span>
          <h2>Loading accounts…</h2>
        </div>
      ) : error ? null : !users.length ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Icon name={status === "pending" ? "check" : "inbox"} size={26} />
          </span>
          <h2>{empty.title}</h2>
          <p>{empty.description}</p>
          {status === "pending" && (
            <p className={styles.emptyHint}>
              Share the worker signup page with anyone joining the team.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className={styles.columns} aria-hidden="true">
            <span>Team member</span>
            <span>Role</span>
            <span>Access</span>
            <span className={styles.actionHeading}>Actions</span>
          </div>
          <ul className={styles.list}>
            {users.map((user) => {
              const name = user.full_name || user.email || "Team member";
              const access =
                user.access_status === "approved"
                  ? user.disabled
                    ? "Disabled"
                    : "Active"
                  : user.access_status === "pending"
                    ? "Pending"
                    : "Rejected";
              const initials = (
                user.full_name
                  ? user.full_name
                      .split(/\s+/)
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join("")
                  : name.slice(0, 2)
              ).toUpperCase();
              return (
                <li key={user.id} className={styles.person}>
                  <div className={styles.identity}>
                    <span className={styles.avatar} aria-hidden="true">
                      {initials}
                    </span>
                    <div className={styles.personDetails}>
                      <h2>{name}</h2>
                      {user.full_name && user.email && <p>{user.email}</p>}
                      {user.phone && <p>{user.phone}</p>}
                      <p className={styles.joined}>
                        {user.access_status === "approved" ? "Joined" : "Requested"}{" "}
                        {new Date(user.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className={styles.roleCell}>
                    <span className={styles.mobileLabel}>Role</span>
                    {admin && user.access_status === "approved" && user.id !== actorId ? (
                      <select
                        aria-label={`Role for ${name}`}
                        value={user.role}
                        disabled={busy}
                        onChange={(e) => void change(user, "role", e.target.value)}
                      >
                        <option value="worker">Worker</option>
                        <option value="manager">Manager</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className={styles.roleName}>
                        {user.role === "admin"
                          ? "Admin"
                          : user.role === "manager"
                            ? "Manager"
                            : "Worker"}
                      </span>
                    )}
                  </div>
                  <div className={styles.accessCell}>
                    <span className={styles.mobileLabel}>Access</span>
                    <span className={`${styles.badge} ${styles[access.toLowerCase()]}`}>
                      <span />
                      {access}
                    </span>
                  </div>
                  <div className={styles.actions}>
                    {user.access_status === "pending" && (
                      <>
                        <button
                          type="button"
                          className={styles.primary}
                          aria-label="Approve request"
                          disabled={busy}
                          onClick={() => void change(user, "approve")}
                        >
                          <Icon name="check" size={15} />
                          Approve
                        </button>
                        <button
                          type="button"
                          aria-label="Reject request"
                          disabled={busy}
                          onClick={() => void change(user, "reject")}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {user.access_status === "approved" && user.id !== actorId && (
                      <button
                        type="button"
                        className={user.disabled ? undefined : styles.disable}
                        disabled={busy}
                        onClick={() => void change(user, user.disabled ? "enable" : "disable")}
                      >
                        {user.disabled ? "Enable account" : "Disable account"}
                      </button>
                    )}
                    {user.id === actorId && <span className={styles.self}>Your account</span>}
                    {user.access_status === "rejected" && (
                      <span className={styles.self}>Request closed</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!loading && !error && (total > 0 || page > 0) && (
        <div className={styles.footer}>
          <span>
            {total} {total === 1 ? "account" : "accounts"}
            {total > 50 || page > 0 ? ` · Page ${page + 1} of ${Math.ceil(total / 50)}` : ""}
          </span>
          {(total > 50 || page > 0) && (
            <nav className={styles.pagination} aria-label="Account pages">
              <button
                type="button"
                disabled={page === 0 || busy}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={(page + 1) * 50 >= total || busy}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
