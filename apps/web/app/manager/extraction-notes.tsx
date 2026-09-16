import { groupExtractionWarnings } from "@/lib/manager/presentation";
import styles from "./receipt-review.module.css";

export function ExtractionNotes({
  warnings,
  editable,
}: {
  warnings: Array<{ field: string; code: string; message: string }>;
  editable: boolean;
}) {
  const groups = groupExtractionWarnings(warnings);
  if (!groups.length) return null;
  const amounts = groups.some((g) => g.code.includes("money"));
  const date = groups.some((g) => g.fields.includes("Purchase date"));
  return (
    <section className={styles.intelligencePanel} aria-label="Extraction warnings">
      <strong>{editable ? "Check before approval" : "Extraction notes"}</strong>
      <p>
        {[
          amounts ? "Verify the amounts against the receipt." : "",
          date ? "Confirm the purchase date, including the year." : "",
          !amounts && !date ? "Check the extracted details against the receipt." : "",
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
      <details>
        <summary>View extraction details ({groups.length})</summary>
        <ul>
          {groups.map((g) => (
            <li key={`${g.code}:${g.message}`}>
              {g.message}
              <br />
              <small>{g.fields.join("; ")}</small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
