"use client";

import { MAX_RECEIPT_PAGES } from "@svl/domain";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FieldApiError, fieldApi } from "@/lib/field/api";
import {
  completeDraft,
  type DraftPage,
  deleteDraft,
  type FieldDraft,
  newDraft,
  readDraft,
  saveDraft,
} from "@/lib/field/drafts";
import { preparePhoto } from "@/lib/field/images";
import { type Acknowledgement, submitDraft } from "@/lib/field/submission";
import styles from "../field.module.css";
import { Icon } from "../glyph";
import { ApiNotice, useFieldActor } from "../shell";

function Photo({ page }: { page: DraftPage }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(page.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [page.blob]);
  // biome-ignore lint/performance/noImgElement: Draft photos are local blob URLs and never go through the image proxy.
  return url ? <img src={url} alt="Receipt page preview" /> : null;
}

export function CaptureReceipt() {
  const actor = useFieldActor();
  const params = useSearchParams();
  const draftId = params.get("draft");
  const [draft, setDraft] = useState<FieldDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<Acknowledgement | null>(null);
  const [discard, setDiscard] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const internalNavigation = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (internalNavigation.current === draftId) return;
    let active = true;
    setDraft(null);
    setError("");
    setResult(null);
    setSaved(false);
    if (draftId) {
      void readDraft(draftId, actor.userId)
        .then((value) => {
          if (!active) return;
          if (!value) setError("This draft is not available for your account on this device.");
          else {
            setDraft(value);
            setSaved(true);
          }
        })
        .catch(() => {
          if (active) setError("Saved draft could not be opened. Try reopening the app.");
        });
    } else setDraft(newDraft(actor.userId));
    return () => {
      active = false;
    };
  }, [draftId, actor.userId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy || (draft?.pages.length && !saved)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, draft, saved]);

  async function persist(value: FieldDraft) {
    setDraft({ ...value });
    setSaved(false);
    await saveDraft(value);
    setSaved(true);
    // Keep the recoverable draft address in the URL without remounting capture.
    internalNavigation.current = value.id;
    window.history.replaceState(null, "", `/field/new?draft=${value.id}`);
  }

  async function perform(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Something went wrong. Your saved draft is still on this device.",
      );
    } finally {
      running.current = false;
      setBusy(false);
      setProgress("");
    }
  }

  async function addPhotos(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (!draft || draft.started || !selected.length) return;
    if (selected.length + draft.pages.length > MAX_RECEIPT_PAGES) {
      setError("A receipt can have up to 5 pages. Choose fewer photos.");
      return;
    }
    await perform(async () => {
      let current = draft;
      for (const file of selected) {
        setProgress(`Preparing page ${current.pages.length + 1}…`);
        const page = await preparePhoto(file);
        current = { ...current, pages: [...current.pages, page] };
        await persist(current);
      }
    });
  }

  async function send() {
    if (!draft) return;
    await perform(async () => {
      if (!saved) await persist(draft);
      const run = async () => {
        const stored = await readDraft(draft.id, actor.userId);
        const current = stored?.started ? stored : draft;
        let acknowledgement: Acknowledgement;
        try {
          acknowledgement = await submitDraft(current, {
            api: fieldApi,
            put: fetch,
            save: persist,
            progress: setProgress,
          });
        } catch (cause) {
          if (cause instanceof FieldApiError && cause.status === 0)
            throw new Error("Could not connect. Your draft is saved. Reconnect and retry sending.");
          throw cause;
        }
        setResult(acknowledgement);
        // A cleanup failure must not turn confirmed delivery into a failed upload.
        await completeDraft(current).catch(() =>
          setError(
            "Receipt sent. A local copy could not be removed; retrying that draft will not send a duplicate.",
          ),
        );
      };
      if (navigator.locks)
        await navigator.locks.request(
          `svl-field-send-${draft.id}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock)
              throw new Error("This receipt is being sent in another tab. Wait for it to finish.");
            await run();
          },
        );
      else await run();
    });
  }

  if (result)
    return (
      <section className={styles.successPanel}>
        <span className={styles.successIcon}>
          <Icon name="check" size={42} />
        </span>
        <p className={styles.eyebrow}>ALL SET</p>
        <h1>Your receipt is sent.</h1>
        <p>
          It’s safely with your office. We’ll check the photos
          <br className={styles.desktopBreak} /> and get the details ready for review.
        </p>
        <div className={styles.deliveryNote}>
          <Icon name="receipt" />
          <span>
            {draft?.pages.length} {draft?.pages.length === 1 ? "page" : "pages"} received <b>·</b>{" "}
            {result.id.slice(0, 8).toUpperCase()}
          </span>
        </div>
        {error && <ApiNotice error={error} />}
        <div className={styles.successActions}>
          <Link className={styles.primary} href={`/field/receipts/${result.id}`}>
            Track this receipt
            <Icon name="arrow" size={18} />
          </Link>
          <button
            className={styles.secondary}
            type="button"
            onClick={() => {
              setDraft(newDraft(actor.userId));
              setResult(null);
              setError("");
              setSaved(false);
              window.history.replaceState(null, "", "/field/new");
            }}
          >
            Add another receipt
          </button>
          <Link className={styles.textLink} href="/field">
            Back to overview
          </Link>
        </div>
      </section>
    );

  return (
    <>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>CAPTURE → CHECK → SEND</p>
          <h1>Let’s get it off your hands.</h1>
          <p>One receipt, all its pages. Your office takes it from here.</p>
        </div>
      </div>
      {error && <ApiNotice error={error} />}
      {!draft ? (
        <p role="status">
          {error
            ? "Open My receipts to find saved drafts, or start a new receipt."
            : "Opening your draft…"}
        </p>
      ) : (
        <div className={styles.captureGrid}>
          <section className={styles.capturePanel}>
            <div className={styles.sectionTitle}>
              <h2>
                Receipt photos <span className={styles.count}>{draft.pages.length} / 5</span>
              </h2>
              {saved && (
                <span className={styles.saved}>
                  <Icon name="check" size={15} />
                  Saved on this device
                </span>
              )}
            </div>
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              className={styles.fileInput}
              aria-label="Take receipt photo"
              disabled={busy || draft.started}
              onChange={(event) => {
                void addPhotos(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              className={styles.fileInput}
              aria-label="Choose receipt photos"
              disabled={busy || draft.started}
              onChange={(event) => {
                void addPhotos(event.target.files);
                event.target.value = "";
              }}
            />
            {draft.pages.length === 0 ? (
              <div className={styles.captureEmpty}>
                <div className={styles.cameraFrame}>
                  <Icon name="camera" size={45} />
                </div>
                <h2>A photo is all it takes.</h2>
                <p>
                  Place the receipt on a flat surface
                  <br />
                  and make sure all four corners are visible.
                </p>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => cameraInput.current?.click()}
                >
                  <Icon name="camera" />
                  Take a photo
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="image" size={18} />
                  Choose from photos
                </button>
                <small>JPEG, PNG, WebP, or supported iPhone photos</small>
              </div>
            ) : (
              <>
                <div className={styles.photoGrid}>
                  {draft.pages.map((page, index) => (
                    <article className={styles.photoCard} key={page.id}>
                      <div className={styles.photoImage}>
                        <Photo page={page} />
                        <span>PAGE {index + 1}</span>
                      </div>
                      <div className={styles.photoActions}>
                        <span>{Math.round(page.blob.size / 1024)} KB</span>
                        <button
                          type="button"
                          aria-label={`Rotate page ${index + 1}`}
                          disabled={busy || draft.started}
                          onClick={() =>
                            void perform(async () => {
                              const rotated = await preparePhoto(page.blob, 90);
                              await persist({
                                ...draft,
                                pages: draft.pages.map((old) =>
                                  old.id === page.id ? rotated : old,
                                ),
                              });
                            })
                          }
                        >
                          <Icon name="rotate" size={18} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove page ${index + 1}`}
                          disabled={busy || draft.started}
                          onClick={() =>
                            void perform(() =>
                              persist({
                                ...draft,
                                pages: draft.pages.filter((old) => old.id !== page.id),
                              }),
                            )
                          }
                        >
                          <Icon name="trash" size={18} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {draft.pages.length < MAX_RECEIPT_PAGES && !draft.started && (
                  <div className={styles.addPages}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => cameraInput.current?.click()}
                    >
                      <Icon name="camera" size={18} />
                      Take another photo
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Icon name="plus" size={18} />
                      Add from photos
                    </button>
                  </div>
                )}
              </>
            )}
            {draft.started && (
              <p className={styles.lockedNote}>
                Sending has started, so these photos are kept together for a safe retry.
              </p>
            )}
            {progress && (
              <div className={styles.progress} role="status">
                <span className={styles.spinner} />
                {progress}
                <small>Keep this page open while sending.</small>
              </div>
            )}
          </section>
          <aside className={styles.captureAside}>
            <section className={styles.tipCard}>
              <span className={styles.eyebrow}>A QUICK CHECK</span>
              <h2>Clear photo. Smooth review.</h2>
              <ul>
                <li>
                  <Icon name="check" />
                  All four corners are in the frame.
                </li>
                <li>
                  <Icon name="check" />
                  The store, date, and total are readable.
                </li>
                <li>
                  <Icon name="check" />
                  No glare, blur, or folded edges.
                </li>
                <li>
                  <Icon name="check" />
                  All pages belong to this receipt.
                </li>
              </ul>
              <p>Your office reviews the details and matches the receipt to the right job.</p>
            </section>
            <section className={styles.locationCard}>
              <div>
                <Icon name="pin" />
                <h3>Location</h3>
                <span>Optional</span>
              </div>
              <p>
                {draft.location
                  ? "Location attached to help your office match the job."
                  : "Add your current location if it helps identify the job."}
              </p>
              {draft.location ? (
                <button
                  className={styles.textButton}
                  type="button"
                  disabled={busy || draft.started}
                  onClick={() => void perform(() => persist({ ...draft, location: null }))}
                >
                  Remove location
                </button>
              ) : (
                <button
                  className={styles.textButton}
                  type="button"
                  disabled={busy || draft.started}
                  onClick={() =>
                    void perform(async () => {
                      if (!navigator.geolocation)
                        throw new Error("Location is unavailable. You can send without it.");
                      setProgress("Getting your location…");
                      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
                        navigator.geolocation.getCurrentPosition(
                          resolve,
                          () =>
                            reject(
                              new Error(
                                "Location could not be added. You can still send the receipt without it.",
                              ),
                            ),
                          { timeout: 10_000, maximumAge: 60_000 },
                        ),
                      );
                      await persist({
                        ...draft,
                        location: {
                          latitude: position.coords.latitude,
                          longitude: position.coords.longitude,
                          accuracyMeters: position.coords.accuracy,
                          capturedAt: new Date(position.timestamp).toISOString(),
                        },
                      });
                    })
                  }
                >
                  Add current location
                  <Icon name="plus" size={16} />
                </button>
              )}
            </section>
            <div className={styles.sendPanel}>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || !draft.pages.length}
                onClick={() => void send()}
              >
                <Icon name="upload" size={20} />
                {busy ? "Working…" : draft.started ? "Retry sending" : "Send to office"}
              </button>
              <p>
                <Icon name="shield" size={14} />
                Sent only after every page is confirmed.
              </p>
              {draft.pages.length > 0 && (
                <Link
                  href="/field/receipts"
                  className={styles.textLink}
                  onClick={(event) => {
                    if (busy || !saved) {
                      event.preventDefault();
                      setError("Wait for the draft to save before leaving this page.");
                    }
                  }}
                >
                  Finish later
                </Link>
              )}
              {draft.pages.length > 0 && !draft.started && (
                <button
                  type="button"
                  className={styles.discard}
                  disabled={busy}
                  onClick={() => setDiscard(true)}
                >
                  Discard draft
                </button>
              )}
              {discard && (
                <div className={styles.notice}>
                  <p>Remove these photos from this device?</p>
                  <div className={styles.actions}>
                    <button
                      className={styles.secondary}
                      type="button"
                      onClick={() => setDiscard(false)}
                    >
                      Keep draft
                    </button>
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await deleteDraft(draft.id, actor.userId);
                          setDraft(newDraft(actor.userId));
                          setSaved(false);
                          setDiscard(false);
                          window.history.replaceState(null, "", "/field/new");
                        })
                      }
                    >
                      Discard photos
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
