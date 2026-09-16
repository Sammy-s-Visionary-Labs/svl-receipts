import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareEmail, renderEmailBody } from "./prepare";

function email(body: string) {
  return Buffer.from(
    `From: Vendor <vendor@example.invalid>\r\nTo: recisvl@gmail.com\r\nSubject: TEST RECEIPT\r\nDate: Wed, 16 Sep 2026 09:00:00 -0400\r\nMIME-Version: 1.0\r\n${body}`,
  );
}
function attachment(type: string, name: string, bytes: Buffer) {
  return email(
    `Content-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nPlease find the receipt attached.\r\n--test\r\nContent-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString("base64")}\r\n--test--`,
  );
}
function pdf(pageCount = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 ${3 + pageCount} 0 R >> >> /Contents ${4 + pageCount} 0 R >>`,
    );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const stream = "BT /F1 18 Tf 20 350 Td (TEST RECEIPT - Total USD 80.00) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
describe("email document preparation", () => {
  it("renders a body receipt without inventing the purchase date from delivery time", async () => {
    const result = await prepareEmail(
      email(
        "Content-Type: text/plain\r\n\r\nTEST RECEIPT\nVendor: Test Yard\nTicket TEST-EMAIL-1\nTotal USD 80.00",
      ),
    );
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.filename).toBe("Email body");
    expect((await sharp(result.documents[0]?.pages[0]).metadata()).width).toBe(1500);
    expect(result.receivedAt).toBe("2026-09-16T13:00:00.000Z");
  });
  it("renders PDF pages in order and retains one document", async () => {
    const result = await prepareEmail(attachment("application/pdf", "test.pdf", pdf(2)));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.pages).toHaveLength(2);
    expect((await sharp(result.documents[0]?.pages[0]).metadata()).format).toBe("jpeg");
  });
  it("holds excessive PDFs instead of silently discarding pages", async () => {
    await expect(prepareEmail(attachment("application/pdf", "long.pdf", pdf(6)))).rejects.toThrow(
      "pdf_page_limit",
    );
  });
  it("decodes image attachments and attached forwarded emails", async () => {
    const image = await sharp({
      create: { width: 500, height: 600, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const inner = attachment("image/png", "test.png", image);
    const result = await prepareEmail(attachment("message/rfc822", "forward.eml", inner));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.filename).toBe("test.png");
  });
  it("converts HTML bodies to inert text", async () => {
    const result = await prepareEmail(
      email(
        'Content-Type: text/html\r\n\r\n<h1>TEST RECEIPT</h1><p>Total: $80.00</p><img src="http://127.0.0.1/private"><script>fetch("https://example.invalid")</script>',
      ),
    );
    expect(result.documents).toHaveLength(1);
  });
  it("holds invalid attachments and overlong bodies", async () => {
    await expect(
      prepareEmail(attachment("application/pdf", "bad.pdf", Buffer.from("not a pdf"))),
    ).rejects.toThrow("invalid_or_locked_pdf");
    await expect(renderEmailBody("x".repeat(30001))).rejects.toThrow("email_body_limit");
  });
});
