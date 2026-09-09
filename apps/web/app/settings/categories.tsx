"use client";
import type { ReceiptCategory } from "@svl/domain";
import { useCallback, useEffect, useState } from "react";
import styles from "../manager/receipt-review.module.css";
export function CategorySettings() {
  const [categories, setCategories] = useState<ReceiptCategory[]>([]);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [keywords, setKeywords] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/manager/categories", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load category configuration.");
    const data = await response.json();
    setCategories(data.categories);
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  return (
    <section className={styles.configuration} aria-labelledby="categories-heading">
      <h2 id="categories-heading">Receipt categories</h2>
      <p>
        Configure Sam’s approved category list here. Categories keep stable IDs; deactivating a
        category preserves historical reviews. No category list is enabled automatically.
      </p>
      {!categories.length && <p>No categories configured.</p>}
      <ul>
        {categories.map((category) => (
          <li key={category.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setId(category.id);
                setLabel(category.label);
                setKeywords(category.keywords.join(", "));
                setActive(category.active);
                setMessage("");
              }}
            >
              {category.label}
            </button>{" "}
            · {category.active ? "Active" : "Inactive"} · {category.id} · version {category.version}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const response = await fetch("/api/admin/categories", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id,
                label,
                active,
                keywords: keywords
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              }),
            });
            if (!response.ok)
              throw new Error(
                "Could not save category. Use a lowercase ID, label, and up to 50 short keywords.",
              );
            await load();
            setMessage("Category configuration saved.");
          } catch (error) {
            setError(error instanceof Error ? error.message : "Could not save category.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className={styles.fields}>
          <label>
            Stable category ID
            <input
              required
              value={id}
              maxLength={100}
              pattern="[a-z0-9][a-z0-9_-]*"
              disabled={busy}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            Display name
            <input
              required
              value={label}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className={styles.full}>
            Suggestion keywords (comma separated)
            <input
              value={keywords}
              maxLength={4000}
              disabled={busy}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={active}
            disabled={busy}
            onChange={(e) => setActive(e.target.checked)}
          />{" "}
          Active for new approvals
        </label>
        <p>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save category"}
          </button>
        </p>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <h3>Evaluation data</h3>
      <p>
        Download manager corrections with text and identities pseudonymized. Use regression results
        to review prompt and scoring changes. Corrections do not change production behavior
        automatically.
      </p>
      <a href="/api/admin/intelligence/evaluation">Download sanitized evaluation JSON</a>
    </section>
  );
}
