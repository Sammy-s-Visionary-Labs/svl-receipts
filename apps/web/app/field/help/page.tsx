import Link from "next/link";
import styles from "../field.module.css";
import { Icon } from "../glyph";

export default function HelpPage() {
  return (
    <>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>SVL RECEIPTS</p>
          <h1>Help & support</h1>
          <p>Find help with photos, uploads, and receipt status.</p>
        </div>
      </div>
      <div className={styles.helpGrid}>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="plus" size={28} />
          </span>
          <h2>Add to your Home Screen</h2>
          <p>On your iPhone, open this app in Safari, then:</p>
          <ol>
            <li>
              <span>1</span>Open Safari’s Share menu.
            </li>
            <li>
              <span>2</span>Choose Add to Home Screen.
            </li>
            <li>
              <span>3</span>Keep Open as Web App enabled if shown, then tap Add.
            </li>
          </ol>
          <p>Open SVL Receipts from your Home Screen and sign in with your SVL account.</p>
        </section>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="camera" size={28} />
          </span>
          <h2>Take a clear receipt photo</h2>
          <p>
            Place your receipt flat in good light. Keep all four corners in frame, hold still, and
            check that the total and date are readable.
          </p>
          <p>
            Add up to five photos for a long receipt. Keep pages in order, and submit separate
            receipts one at a time.
          </p>
          <Link className={styles.textLink} href="/field/new">
            Add a receipt
            <Icon name="arrow" size={18} />
          </Link>
        </section>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="wifi" size={28} />
          </span>
          <h2>Saved drafts and uploads</h2>
          <p>
            Photos you prepare are saved as drafts in this browser on this device. If sending is
            interrupted, open your saved draft and retry.
          </p>
          <p>
            You need a connection to open the app, sign in, send receipts, and refresh status. Keep
            the app open while sending. It does not upload in the background.
          </p>
          <p>
            Drafts stay with the account that created them. Clearing browser data removes them, so
            send important receipts before clearing storage.
          </p>
        </section>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="receipt" size={28} />
          </span>
          <h2>Track your receipt</h2>
          <p>Your office receives each submitted receipt for review and job matching.</p>
          <p>
            Check My receipts for Sent, In review, Approved, or Needs retake. If photos need a
            retake, follow the guidance and send a clearer receipt.
          </p>
          <p>
            Open My receipts to check for updates. For account access or questions about a review,
            contact your manager.
          </p>
        </section>
      </div>
    </>
  );
}
