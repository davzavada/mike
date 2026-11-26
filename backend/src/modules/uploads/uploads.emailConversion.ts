// Turning an email file into documents Mike can store, before upload.
//
// The browser sends the .eml or .msg here and gets back ordinary files: a
// PDF of the message, and each attachment of a supported type. It then
// uploads those through the normal upload session. No email is stored and no
// document type is added: see lib/emailFile.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConversionError, officeFileToPdf } from "../../lib/convert";
import { contentTypeForDocumentType, documentSuffix } from "../../lib/documentTypes";
import {
  EmailFileError,
  emailToHtml,
  isEmailFilename,
  parseEmailFile,
} from "../../lib/emailFile";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

/** Largest email file accepted, attachments included. */
export const EMAIL_CONVERSION_MAX_BYTES = 30 * 1024 * 1024;

export type ConvertedEmail = {
  files: Array<{
    filename: string;
    content_type: string;
    /** Base64. */
    data: string;
  }>;
  /** Attachments named in the message PDF but not returned as files. */
  skipped_attachments: string[];
};

type HtmlToPdf = (html: string) => Promise<Buffer>;

async function htmlToPdfWithLibreOffice(html: string): Promise<Buffer> {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "mike-email-"),
  );
  try {
    const input = path.join(directory, "message.html");
    await fs.promises.writeFile(input, html, "utf8");
    const pdf = await officeFileToPdf(input, path.join(directory, "out"));
    return await fs.promises.readFile(pdf);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

/** "Re: lease.eml" → "Re: lease", without path segments or control characters. */
function baseName(filename: string): string {
  const name = path
    .basename(filename.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\.(eml|msg)$/i, "")
    .trim();
  return name || "Email";
}

export async function convertEmailUpload(
  filename: string,
  bytes: Buffer,
  htmlToPdf: HtmlToPdf = htmlToPdfWithLibreOffice,
): Promise<ServiceResult<ConvertedEmail>> {
  if (!isEmailFilename(filename)) {
    return failure("validation", "Only .eml and .msg files can be converted.");
  }
  if (bytes.length === 0) {
    return failure("validation", "The email file is empty.");
  }
  try {
    const email = await parseEmailFile(filename, bytes);
    const base = baseName(filename);
    const pdf = await htmlToPdf(emailToHtml(email));
    return ok({
      files: [
        {
          filename: `${base}.pdf`,
          content_type: "application/pdf",
          data: pdf.toString("base64"),
        },
        ...email.attachments.map((attachment) => ({
          filename: `${base} - ${attachment.filename}`,
          content_type: contentTypeForDocumentType(
            documentSuffix(attachment.filename),
          ),
          data: attachment.content.toString("base64"),
        })),
      ],
      skipped_attachments: email.skippedAttachments,
    });
  } catch (error) {
    if (error instanceof EmailFileError) {
      return failure(
        "validation",
        "This email file could not be read. Save it again as .eml or .msg and retry.",
        "email_unreadable",
      );
    }
    if (error instanceof ConversionError && error.code === "conversion_unavailable") {
      return failure(
        "unavailable",
        "Email files cannot be converted on this server.",
      );
    }
    return internalFailure(error);
  }
}
