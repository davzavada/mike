import { describe, expect, it } from "vitest";

import { extractDocumentMarkdown } from "./documentMarkdown";
import { extractDocumentText } from "./documentText";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const EML = Buffer.from(
  [
    "From: Jan Novák <jan@example.cz>",
    "To: bob@example.com",
    "Subject: Lease terms",
    "Date: Fri, 20 Nov 2026 09:15:00 +0100",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64("The rent is in the spreadsheet."),
    "--b1",
    'Content-Type: text/csv; name="broken.docx"',
    'Content-Disposition: attachment; filename="broken.docx"',
    "Content-Transfer-Encoding: base64",
    "",
    b64("not a real docx"),
    "--b1",
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: attachment; filename="logo.png"',
    "Content-Transfer-Encoding: base64",
    "",
    b64("png"),
    "--b1--",
    "",
  ].join("\r\n"),
);
const raw = EML.buffer.slice(
  EML.byteOffset,
  EML.byteOffset + EML.byteLength,
) as ArrayBuffer;

describe("email text", () => {
  it("is the headers and body, then each attachment under its name", async () => {
    const { text, textlessPageCount } = await extractDocumentText(raw, "eml");
    expect(textlessPageCount).toBeNull();
    expect(text).toContain("Subject: Lease terms");
    expect(text).toContain("From: ");
    expect(text).toContain("jan@example.cz");
    expect(text).toContain("Date: Fri, 20 Nov 2026 09:15:00 +0100");
    expect(text).toContain("Attachments: broken.docx, logo.png (not read)");
    expect(text).toContain("The rent is in the spreadsheet.");
    expect(text.indexOf("The rent")).toBeLessThan(
      text.indexOf("--- Attachment: broken.docx ---"),
    );
  });

  it("keeps the message when an attachment cannot be read", async () => {
    const { text } = await extractDocumentText(raw, "eml");
    expect(text).toContain(
      "--- Attachment: broken.docx ---\n(This attachment could not be read.)",
    );
    // An attachment of an unsupported type has no section of its own.
    expect(text).not.toContain("--- Attachment: logo.png");
  });

  it("gives tabular review the same text", async () => {
    await expect(extractDocumentMarkdown(raw, "EML")).resolves.toBe(
      (await extractDocumentText(raw, "eml")).text,
    );
  });
});
