import Link from "next/link";
import styles from "../field.module.css";
import { Icon } from "../glyph";

export default function HelpPage() {
  return (
    <>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>A LITTLE HELP IN THE FIELD</p>
          <h1>Ready when you are.</h1>
          <p>Keep receipts moving, right from your browser.</p>
        </div>
      </div>
      <div className={styles.helpGrid}>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="plus" size={28} />
          </span>
          <h2>Give it a place on your Home Screen.</h2>
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
          <p>
            Open the SVL Receipts icon whenever you have a receipt. Sign in with the same account
            you use for the receipt app.
          </p>
        </section>
        <section className={styles.helpCard}>
          <span className={styles.helpIcon}>
            <Icon name="camera" size={28} />
          </span>
          <h2>Make every photo count.</h2>
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
          <h2>A weak signal can wait.</h2>
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
          <h2>One receipt, one shared workflow.</h2>
          <p>
            Your web submissions appear in the same office review queue as receipts from the native
            app.
          </p>
          <p>
            Check My receipts for Sent, In review, Approved, or Needs retake. If photos need a
            retake, follow the guidance and send a clearer receipt.
          </p>
          <p>
            For account access or questions about a review, contact your manager. This web app
            checks status when opened; it does not send push notifications.
          </p>
        </section>
      </div>
    </>
  );
}
