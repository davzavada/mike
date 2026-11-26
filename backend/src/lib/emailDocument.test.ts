import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { emailToPdf, type ToPdf } from "./emailDocument";
import { EmailFileError } from "./emailFile";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");

/** A PDF of `pages` pages, each a different width so order can be checked. */
async function pdfOf(...widths: number[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const width of widths) doc.addPage([width, 100]);
  return doc.save();
}

async function pageWidths(pdf: Buffer): Promise<number[]> {
  const { PDFDocument } = await import("pdf-lib");
  return (await PDFDocument.load(pdf)).getPages().map((page) => page.getWidth());
}

function eml(attachments: Array<{ name: string; data: string }>): Buffer {
  return Buffer.from(
    [
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
      ...attachments.flatMap((attachment) => [
        "--b1",
        `Content-Type: application/octet-stream; name="${attachment.name}"`,
        `Content-Disposition: attachment; filename="${attachment.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        attachment.data,
      ]),
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

/**
 * Stands in for LibreOffice: the message page is 200 wide, a converted Word
 * file 300; a file whose content says "broken" fails to convert.
 */
function fakeConverter() {
  const seen: Array<{ name: string; html?: string }> = [];
  const toPdf: ToPdf = async (inputPath, outputDirectory) => {
    const content = fs.readFileSync(inputPath, "utf8");
    seen.push({
      name: path.basename(inputPath),
      ...(inputPath.endsWith(".html") ? { html: content } : {}),
    });
    if (content === "broken") throw new Error("conversion failed");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, "out.pdf");
    fs.writeFileSync(output, await pdfOf(inputPath.endsWith(".html") ? 200 : 300));
    return output;
  };
  return { toPdf: vi.fn(toPdf), seen };
}

describe("emailToPdf", () => {
  it("is the message followed by each attachment's pages, in order", async () => {
    const { toPdf, seen } = fakeConverter();
    const pdf = await emailToPdf(
      eml([
        { name: "scan.pdf", data: b64(await pdfOf(400, 401)) },
        { name: "../../evil name.docx", data: b64("word bytes") },
      ]),
      "eml",
      toPdf,
    );
    expect(await pageWidths(pdf)).toEqual([200, 400, 401, 300]);
    // A PDF attachment is used as it is; only the Word file and the message
    // go through the converter, under names the message did not choose.
    expect(seen.map((entry) => entry.name)).toEqual([
      "attachment-1.docx",
      "message.html",
    ]);
    expect(seen[1].html).toContain("scan.pdf, evil name.docx");
    expect(seen[1].html).not.toContain("not shown");
  });

  it("names what it cannot show and still shows the rest", async () => {
    const { toPdf, seen } = fakeConverter();
    const pdf = await emailToPdf(
      eml([
        { name: "photo.png", data: b64("png") },
        { name: "damaged.pdf", data: b64("this is not a pdf") },
        { name: "fails.docx", data: b64("broken") },
        { name: "good.pdf", data: b64(await pdfOf(400)) },
      ]),
      "eml",
      toPdf,
    );
    expect(await pageWidths(pdf)).toEqual([200, 400]);
    const html = seen.at(-1)?.html ?? "";
    expect(html).toContain("damaged.pdf (not shown)");
    expect(html).toContain("fails.docx (not shown)");
    expect(html).toContain("photo.png (not shown)");
    expect(html).toMatch(/good\.pdf(?! \(not shown\))/);
  });

  it("is just the message for an email without attachments", async () => {
    const { toPdf } = fakeConverter();
    expect(await pageWidths(await emailToPdf(eml([]), "eml", toPdf))).toEqual([
      200,
    ]);
  });

  it("leaves no temporary files behind, also when it fails", async () => {
    const before = fs
      .readdirSync(require("node:os").tmpdir())
      .filter((name) => name.startsWith("mike-email-")).length;
    await emailToPdf(eml([]), "eml", fakeConverter().toPdf);
    await expect(
      emailToPdf(eml([]), "eml", async () => {
        throw new Error("no converter");
      }),
    ).rejects.toThrow("no converter");
    expect(
      fs
        .readdirSync(require("node:os").tmpdir())
        .filter((name) => name.startsWith("mike-email-")).length,
    ).toBe(before);
  });

  it("refuses a file that is not an email", async () => {
    await expect(
      emailToPdf(Buffer.from("not a message"), "msg", fakeConverter().toPdf),
    ).rejects.toBeInstanceOf(EmailFileError);
  });
});
