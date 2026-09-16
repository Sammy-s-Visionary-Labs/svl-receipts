import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { simpleParser } from "mailparser";
import sharp from "sharp";
import { MAX_EMAIL_BYTES } from "./config";

export class EmailPreparationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type EmailDocument = { filename: string; pages: Buffer[] };
export type PreparedEmail = {
  sender: string;
  subject: string;
  receivedAt: string | null;
  documents: EmailDocument[];
};
const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
const pdfRoot = path.dirname(runtimeRequire.resolve("pdfjs-dist/package.json"));
const fontPath = path.join(process.cwd(), "assets/fonts/NotoSans.ttf");
let fontLoaded = false;
function checkDeadline(deadlineAt: number) {
  if (Date.now() > deadlineAt) throw new EmailPreparationError("preparation_timeout");
}
async function pdfPages(bytes: Buffer, deadlineAt: number) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    maxImageSize: 50_000_000,
    standardFontDataUrl: path.join(pdfRoot, "standard_fonts/"),
    wasmUrl: path.join(pdfRoot, "wasm/"),
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages < 1 || pdf.numPages > 5) throw new EmailPreparationError("pdf_page_limit");
    const pages: Buffer[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      checkDeadline(deadlineAt);
      const page = await pdf.getPage(n);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 3000 / original.width, 4000 / original.height);
      const viewport = page.getViewport({ scale });
      if (!Number.isFinite(viewport.width) || viewport.width < 1 || viewport.height < 1)
        throw new EmailPreparationError("invalid_pdf");
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvas: null,
        canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      pages.push(await canvas.encode("jpeg", 92));
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (error instanceof EmailPreparationError) throw error;
    throw new EmailPreparationError("invalid_or_locked_pdf");
  } finally {
    await loading.destroy();
  }
}
export async function renderEmailBody(text: string): Promise<Buffer[]> {
  if (text.length > 30000) throw new EmailPreparationError("email_body_limit");
  if (!fontLoaded) {
    if (!GlobalFonts.registerFromPath(fontPath, "SVL Receipt"))
      throw new EmailPreparationError("font_unavailable");
    fontLoaded = true;
  }
  const canvas = createCanvas(1500, 2000);
  const ctx = canvas.getContext("2d");
  ctx.font = '26px "SVL Receipt"';
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    // Break long tokens as well as paragraphs; never silently clip body content.
    for (const char of paragraph) {
      if (ctx.measureText(line + char).width > 1340) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  if (lines.length > 250) throw new EmailPreparationError("email_body_limit");
  const pages: Buffer[] = [];
  for (let start = 0; start < lines.length; start += 50) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1500, 2000);
    ctx.fillStyle = "#1e3b31";
    ctx.font = 'bold 28px "SVL Receipt"';
    ctx.fillText("EMAILED RECEIPT", 80, 90);
    ctx.fillStyle = "#111111";
    ctx.font = '26px "SVL Receipt"';
    lines.slice(start, start + 50).forEach((line, i) => {
      ctx.fillText(line, 80, 155 + i * 35);
    });
    pages.push(await canvas.encode("jpeg", 92));
  }
  return pages;
}
export async function prepareEmail(
  raw: Buffer,
  deadlineAt = Date.now() + 90000,
): Promise<PreparedEmail> {
  if (!raw.length || raw.length > MAX_EMAIL_BYTES)
    throw new EmailPreparationError("email_size_limit");
  const documents: EmailDocument[] = [];
  let totalPages = 0;
  async function parse(
    bytes: Buffer,
    depth: number,
  ): Promise<{ sender: string; subject: string; receivedAt: string | null }> {
    checkDeadline(deadlineAt);
    if (depth > 3) throw new EmailPreparationError("forward_depth_limit");
    const mail = await simpleParser(bytes, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: 1000000,
    });
    if (mail.attachments.length > 30) throw new EmailPreparationError("attachment_limit");
    const sender = mail.from?.text ?? "";
    const subject = mail.subject ?? "";
    let attachedReceipts = 0;
    for (const attachment of mail.attachments) {
      checkDeadline(deadlineAt);
      const type = attachment.contentType.toLowerCase();
      const filename = (attachment.filename || "Receipt").slice(0, 255);
      if (type === "message/rfc822" || /\.eml$/i.test(filename)) {
        await parse(attachment.content, depth + 1);
        attachedReceipts++;
        continue;
      }
      let pages: Buffer[] | null = null;
      if (type === "application/pdf" || /\.pdf$/i.test(filename))
        pages = await pdfPages(attachment.content, deadlineAt);
      else if (type.startsWith("image/")) {
        // Small inline signatures/tracking images are not receipt attachments.
        const image = sharp(attachment.content, { limitInputPixels: 50000000, failOn: "error" });
        const metadata = await image.metadata().catch(() => {
          throw new EmailPreparationError("invalid_image");
        });
        if (
          attachment.contentDisposition === "inline" &&
          (metadata.width ?? 0) < 400 &&
          (metadata.height ?? 0) < 400
        )
          continue;
        if ((metadata.pages ?? 1) > 1)
          throw new EmailPreparationError("multipage_image_unsupported");
        pages = [
          await image
            .rotate()
            .resize({ width: 3000, height: 4000, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 92 })
            .toBuffer(),
        ];
      } else if (attachment.contentDisposition !== "inline")
        throw new EmailPreparationError("unsupported_attachment");
      if (pages) {
        documents.push({ filename, pages });
        totalPages += pages.length;
        attachedReceipts++;
      }
      if (documents.length > 20 || totalPages > 40)
        throw new EmailPreparationError("attachment_limit");
    }
    const body = (mail.text ?? "").trim();
    // Keep financial email-body content even alongside attachments; duplicate
    // review reconciles a body and attachment that describe the same purchase.
    if (
      body &&
      (!attachedReceipts ||
        /\b(total|amount paid|amount due)\b[\s\S]{0,80}(?:\$|USD|\d+[.,]\d{2})/i.test(body))
    ) {
      const pages = await renderEmailBody(body);
      documents.push({ filename: depth ? "Forwarded email body" : "Email body", pages });
      totalPages += pages.length;
    }
    return {
      sender: sender.slice(0, 320),
      subject: subject.slice(0, 500),
      receivedAt: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : null,
    };
  }
  const metadata = await parse(raw, 0);
  if (!documents.length) throw new EmailPreparationError("no_receipt_content");
  if (documents.length > 20 || totalPages > 40) throw new EmailPreparationError("attachment_limit");
  return { ...metadata, documents };
}
