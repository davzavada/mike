import { describe, expect, it } from "vitest";

import {
  EmailFileError,
  emailToHtml,
  htmlToPlainText,
  parseEmailFile,
} from "./emailFile";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** A message with a text body, a PDF, an image and an oddly named file. */
const EML = [
  "From: Jan Novák <jan.novak@example.cz>",
  "To: =?UTF-8?B?" + b64("Žaneta Šťastná") + "?= <zaneta@example.cz>, bob@example.com",
  "Cc: carol@example.com",
  "Subject: =?UTF-8?B?" + b64("Smlouva o dílo – připomínky") + "?=",
  "Date: Fri, 20 Nov 2026 09:15:00 +0100",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: base64",
  "",
  b64("Dobrý den,\n\nposílám připomínky k čl. 5.\nS pozdravem\nJan"),
  "--b1",
  'Content-Type: application/pdf; name="smlouva.pdf"',
  'Content-Disposition: attachment; filename="smlouva.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  b64("%PDF-1.4 fake"),
  "--b1",
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: attachment; filename="logo.png"',
  "Content-Transfer-Encoding: base64",
  "",
  b64("png"),
  "--b1",
  'Content-Type: application/octet-stream; name="../../etc/passwd.docx"',
  'Content-Disposition: attachment; filename="../../etc/passwd.docx"',
  "Content-Transfer-Encoding: base64",
  "",
  b64("docx"),
  "--b1--",
  "",
].join("\r\n");

describe("parseEmailFile (.eml)", () => {
  it("reads headers, body and attachments", async () => {
    const email = await parseEmailFile("message.eml", Buffer.from(EML));
    expect(email.subject).toBe("Smlouva o dílo – připomínky");
    expect(email.from).toContain("jan.novak@example.cz");
    expect(email.to).toContain("Žaneta Šťastná");
    expect(email.to).toContain("bob@example.com");
    expect(email.cc).toBe("carol@example.com");
    expect(email.date).toBe("Fri, 20 Nov 2026 09:15:00 +0100");
    expect(email.text).toBe(
      "Dobrý den,\n\nposílám připomínky k čl. 5.\nS pozdravem\nJan",
    );
  });

  it("keeps attachments Mike can store and only names the rest", async () => {
    const email = await parseEmailFile("message.eml", Buffer.from(EML));
    expect(email.attachments.map((a) => a.filename)).toEqual([
      "smlouva.pdf",
      // A path in an attachment's name never becomes part of a filename.
      "passwd.docx",
    ]);
    expect(email.attachments[0].content.toString()).toBe("%PDF-1.4 fake");
    expect(email.skippedAttachments).toEqual(["logo.png"]);
  });

  it("reads an HTML-only body as text, without its markup or scripts", async () => {
    const eml = [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: Hi",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "",
      '<html><head><style>p{color:red}</style></head><body><p>First &amp; second</p><script>alert(1)</script><img src="https://tracker.example/p.gif"><p>Third</p></body></html>',
      "",
    ].join("\r\n");
    const email = await parseEmailFile("m.eml", Buffer.from(eml));
    expect(email.text).toContain("First & second");
    expect(email.text).toContain("Third");
    expect(email.text).not.toMatch(/alert|color:red|<p>|<img/);
  });

  it.each(["", "\n\n"])("refuses the file %j, which is not an email", async (bytes) => {
    await expect(
      parseEmailFile("empty.eml", Buffer.from(bytes)),
    ).rejects.toBeInstanceOf(EmailFileError);
  });
});

describe("parseEmailFile (.msg)", () => {
  it("refuses bytes that are not an Outlook message", async () => {
    await expect(
      parseEmailFile("note.msg", Buffer.from("this is not a compound file")),
    ).rejects.toBeInstanceOf(EmailFileError);
  });
});

describe("emailToHtml", () => {
  const email = {
    subject: 'Offer <script>alert("x")</script>',
    from: "Eve <eve@example.com>",
    to: "bob@example.com",
    cc: "",
    date: "2026-11-20 08:15 UTC",
    text: 'Line one\nLine two\n\n<img src="https://tracker.example/p.gif">',
    attachments: [{ filename: "a.pdf", content: Buffer.from("x") }],
    skippedAttachments: ["logo.png"],
  };

  it("escapes every value, so the message cannot add markup", () => {
    const html = emailToHtml(email);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Eve &lt;eve@example.com&gt;");
  });

  it("marks the attachments a caller says are not shown", () => {
    expect(emailToHtml(email, ["a.pdf", "logo.png"])).toContain(
      "a.pdf (not shown), logo.png (not shown)",
    );
  });

  it("lists attachments, marks the ones left out, and omits empty rows", () => {
    const html = emailToHtml(email);
    expect(html).toContain("a.pdf, logo.png (not shown)");
    expect(html).not.toContain("Cc:");
    expect(html).toContain("<p>Line one<br>Line two</p>");
  });

  it("puts the subject in the header table, where the converter keeps it", () => {
    const html = emailToHtml({ ...email, subject: "Lease" });
    expect(html).toMatch(/<body>\s*<table><tr><td colspan="2" class="s">Lease<\/td>/);
    expect(emailToHtml({ ...email, subject: "" })).toContain("(no subject)");
  });

  it("names nothing the converter could fetch", () => {
    // The message's own markup survives only as escaped text.
    expect(emailToHtml(email)).not.toMatch(
      /<[^>]*\b(src|href)\s*=|url\(|@import/i,
    );
  });
});

describe("helpers", () => {
  it("htmlToPlainText keeps the reading order and decodes entities", () => {
    expect(
      htmlToPlainText("<div>A&nbsp;&lt;b&gt;</div><p>C<br>D</p>&#269;"),
    ).toBe("A <b>\nC\nD\nč");
  });
});
