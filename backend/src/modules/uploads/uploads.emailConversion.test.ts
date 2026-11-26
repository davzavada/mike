import { describe, expect, it, vi } from "vitest";

import { ConversionError } from "../../lib/convert";
import { convertEmailUpload } from "./uploads.emailConversion";

const EML = [
  "From: a@example.com",
  "To: b@example.com",
  "Subject: Lease",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain",
  "",
  "See attached.",
  "--b1",
  'Content-Type: application/pdf; name="lease.pdf"',
  'Content-Disposition: attachment; filename="lease.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-attachment").toString("base64"),
  "--b1",
  'Content-Type: application/zip; name="photos.zip"',
  'Content-Disposition: attachment; filename="photos.zip"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("zip").toString("base64"),
  "--b1--",
  "",
].join("\r\n");

const pdf = async (_html: string) => Buffer.from("%PDF-message");

describe("convertEmailUpload", () => {
  it("returns the message as a PDF and each supported attachment", async () => {
    const htmlToPdf = vi.fn(pdf);
    const result = await convertEmailUpload(
      "C:\\mail\\Re lease.eml",
      Buffer.from(EML),
      htmlToPdf,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      result.data.files.map((file) => [file.filename, file.content_type]),
    ).toEqual([
      ["Re lease.pdf", "application/pdf"],
      ["Re lease - lease.pdf", "application/pdf"],
    ]);
    expect(Buffer.from(result.data.files[0].data, "base64").toString()).toBe(
      "%PDF-message",
    );
    expect(Buffer.from(result.data.files[1].data, "base64").toString()).toBe(
      "%PDF-attachment",
    );
    expect(result.data.skipped_attachments).toEqual(["photos.zip"]);
    // The converter is handed the page, with the skipped attachment noted.
    expect(htmlToPdf.mock.calls[0][0]).toContain("photos.zip (not imported)");
  });

  it.each(["contract.pdf", "notes.txt", ""])(
    "refuses %j, which is not an email file",
    async (filename) => {
      await expect(
        convertEmailUpload(filename, Buffer.from(EML), pdf),
      ).resolves.toMatchObject({ ok: false, kind: "validation" });
    },
  );

  it("refuses an empty or unreadable file without converting anything", async () => {
    const htmlToPdf = vi.fn(pdf);
    await expect(
      convertEmailUpload("a.eml", Buffer.alloc(0), htmlToPdf),
    ).resolves.toMatchObject({ ok: false, kind: "validation" });
    await expect(
      convertEmailUpload("a.msg", Buffer.from("not a message"), htmlToPdf),
    ).resolves.toMatchObject({
      ok: false,
      kind: "validation",
      code: "email_unreadable",
    });
    expect(htmlToPdf).not.toHaveBeenCalled();
  });

  it("says so when the server has no converter", async () => {
    await expect(
      convertEmailUpload("a.eml", Buffer.from(EML), async () => {
        throw new ConversionError("conversion.unavailable", "no soffice");
      }),
    ).resolves.toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("reports any other converter failure as an internal error", async () => {
    const boom = new Error("soffice crashed");
    await expect(
      convertEmailUpload("a.eml", Buffer.from(EML), async () => {
        throw boom;
      }),
    ).resolves.toMatchObject({ ok: false, kind: "error", error: boom });
  });
});
