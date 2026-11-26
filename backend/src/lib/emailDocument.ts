// What Mike shows for a stored email file (.eml, .msg): one PDF with the
// message first and then each attachment's pages, in the order the message
// lists them.
//
// The email itself is stored unchanged and can be downloaded as it was. This
// PDF is its rendition, as a Word file's converted PDF is: the preview shows
// it, and quotes are located in it. The text the model reads is built
// separately, from the same parts (lib/extraction/documentText.ts).
//
// Attachments of a type Mike cannot show (images, archives, another email),
// or that fail to convert, are named in the message's header as "not shown".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { officeFileToPdf } from "./convert";
import { documentSuffix } from "./documentTypes";
import { emailToHtml, parseEmailFile, type EmailAttachment } from "./emailFile";

type Pdf = Awaited<
  ReturnType<(typeof import("pdf-lib"))["PDFDocument"]["load"]>
>;

/** Convert one file on disk to PDF bytes; injectable so tests need no LibreOffice. */
export type ToPdf = (inputPath: string, outputDirectory: string) => Promise<string>;

async function attachmentPdfBytes(
  attachment: EmailAttachment,
  directory: string,
  index: number,
  toPdf: ToPdf,
): Promise<Buffer> {
  const type = documentSuffix(attachment.filename);
  if (type === "pdf") return attachment.content;
  // A fixed name: the attachment's own name never touches the filesystem.
  const input = path.join(directory, `attachment-${index}.${type}`);
  await fs.promises.writeFile(input, attachment.content);
  return fs.promises.readFile(
    await toPdf(input, path.join(directory, `attachment-${index}-out`)),
  );
}

export async function emailToPdf(
  bytes: Buffer,
  fileType: string,
  toPdf: ToPdf = officeFileToPdf,
): Promise<Buffer> {
  const email = await parseEmailFile(`message.${fileType}`, bytes);
  const { PDFDocument } = await import("pdf-lib");
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "mike-email-"),
  );
  try {
    // Attachments first: the message's header says which of them follow.
    const shown: Pdf[] = [];
    const notShown = [...email.skippedAttachments];
    for (const [index, attachment] of email.attachments.entries()) {
      try {
        shown.push(
          await PDFDocument.load(
            await attachmentPdfBytes(attachment, directory, index, toPdf),
            { ignoreEncryption: true },
          ),
        );
      } catch {
        notShown.push(attachment.filename);
      }
    }

    const messagePath = path.join(directory, "message.html");
    await fs.promises.writeFile(messagePath, emailToHtml(email, notShown), "utf8");
    const message = await PDFDocument.load(
      await fs.promises.readFile(
        await toPdf(messagePath, path.join(directory, "message-out")),
      ),
    );

    const merged = await PDFDocument.create();
    for (const part of [message, ...shown]) {
      const pages = await merged.copyPages(part, part.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    return Buffer.from(await merged.save());
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
