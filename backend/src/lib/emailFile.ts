// Reading an email file (.eml, or Outlook's .msg) into the parts Mike keeps:
// its headers, its body as plain text, and its attachments.
//
// Mike stores no "email" document type. An uploaded email becomes a PDF of
// the message (see modules/uploads/uploads.emailConversion.ts) plus one
// document per attachment of a type Mike already supports, so everything
// downstream (preview, text extraction, citations, tabular review) treats it
// like any other document.
//
// The body is always taken as text. An HTML body is reduced to its text
// rather than rendered: rendering it would let the message decide what the
// converter fetches (tracking pixels, remote stylesheets) and what the PDF
// shows.
import path from "node:path";

import MsgReader from "@kenjiuno/msgreader";

import { AppError } from "./appError";
import { ALLOWED_DOCUMENT_TYPES, documentSuffix } from "./documentTypes";

export const EMAIL_FILE_TYPES = new Set(["eml", "msg"]);

export function isEmailFilename(filename: string): boolean {
  return EMAIL_FILE_TYPES.has(documentSuffix(filename));
}

/** The file is not an email this reader understands. */
export class EmailFileError extends AppError {
  constructor(options?: { cause?: unknown }) {
    super("email.unreadable", "The email file could not be read.", options);
  }
}

export type EmailAttachment = {
  filename: string;
  content: Buffer;
};

export type ParsedEmail = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** As the message states it, formatted for reading; "" when it has none. */
  date: string;
  text: string;
  /** Attachments of a type Mike can store as documents. */
  attachments: EmailAttachment[];
  /** Names of the attachments that are left out (images, archives, …). */
  skippedAttachments: string[];
};

const MAX_ATTACHMENTS = 50;

function formatDate(value: Date | string | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Tags out, entities decoded: enough to read an HTML-only body as text. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sort a message's attachments into the ones kept as documents and the ones
 * only named. A name is reduced to its last path segment: it becomes part of
 * a filename.
 */
function sortAttachments(
  candidates: Array<{ filename: string | undefined; content: () => Buffer }>,
): Pick<ParsedEmail, "attachments" | "skippedAttachments"> {
  const attachments: EmailAttachment[] = [];
  const skippedAttachments: string[] = [];
  for (const candidate of candidates) {
    const filename = path
      .basename((candidate.filename ?? "").replace(/\\/g, "/"))
      .replace(/[\u0000-\u001f]/g, "")
      .trim();
    if (!filename) continue;
    if (
      ALLOWED_DOCUMENT_TYPES.has(documentSuffix(filename)) &&
      attachments.length < MAX_ATTACHMENTS
    ) {
      attachments.push({ filename, content: candidate.content() });
    } else {
      skippedAttachments.push(filename);
    }
  }
  return { attachments, skippedAttachments };
}

async function parseEml(bytes: Buffer): Promise<ParsedEmail> {
  const { simpleParser } = await import("mailparser");
  const mail = await simpleParser(bytes, {
    skipImageLinks: true,
    skipTextToHtml: true,
  });
  const addresses = (
    value: { text: string } | Array<{ text: string }> | undefined,
  ) =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((entry) => entry.text)
      .filter(Boolean)
      .join(", ");
  // The parser accepts any bytes. A file with no sender, recipient, subject,
  // date, body or attachment is not an email, whatever its name.
  if (
    !mail.from &&
    !mail.to &&
    !mail.subject &&
    !mail.date &&
    !mail.text?.trim() &&
    !mail.html &&
    mail.attachments.length === 0
  ) {
    throw new EmailFileError();
  }
  return {
    subject: mail.subject ?? "",
    from: addresses(mail.from),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    // As the message states it, time zone included: the header is evidence.
    date:
      mail.headerLines
        ?.find((header) => header.key === "date")
        ?.line.replace(/^date:\s*/i, "")
        .replace(/\s+/g, " ")
        .trim() || formatDate(mail.date),
    text: mail.text?.trim() || (mail.html ? htmlToPlainText(mail.html) : ""),
    ...sortAttachments(
      mail.attachments
        // Images a message shows inline are part of its HTML body.
        .filter((attachment) => !attachment.related)
        .map((attachment) => ({
          filename: attachment.filename,
          content: () => attachment.content,
        })),
    ),
  };
}

function parseMsg(bytes: Buffer): ParsedEmail {
  const reader = new MsgReader(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
  const message = reader.getFileData();
  if ((message as { error?: string }).error) throw new EmailFileError();
  const person = (name?: string, email?: string) =>
    name && email && name !== email ? `${name} <${email}>` : (email ?? name ?? "");
  const recipients = (kind: "to" | "cc") =>
    (message.recipients ?? [])
      .filter((recipient) => (recipient.recipType ?? "to") === kind)
      .map((recipient) =>
        person(recipient.name, recipient.smtpAddress ?? recipient.email),
      )
      .filter(Boolean)
      .join(", ");
  const html =
    message.bodyHtml ??
    (message.html ? Buffer.from(message.html).toString("utf8") : "");
  return {
    subject: message.subject ?? "",
    from: person(
      message.senderName,
      message.senderSmtpAddress ?? message.senderEmail,
    ),
    to: recipients("to"),
    cc: recipients("cc"),
    date: formatDate(message.messageDeliveryTime ?? message.clientSubmitTime),
    text: message.body?.trim() || (html ? htmlToPlainText(html) : ""),
    ...sortAttachments(
      (message.attachments ?? [])
        // Hidden attachments are the message's inline images; an embedded
        // message would need this whole conversion again.
        .filter(
          (attachment) =>
            !attachment.attachmentHidden && !attachment.innerMsgContent,
        )
        .map((attachment) => ({
          filename: attachment.fileName ?? attachment.name,
          content: () => Buffer.from(reader.getAttachment(attachment).content),
        })),
    ),
  };
}

/** Read an email file by its extension. Throws EmailFileError when it is not one. */
export async function parseEmailFile(
  filename: string,
  bytes: Buffer,
): Promise<ParsedEmail> {
  try {
    return documentSuffix(filename) === "msg"
      ? parseMsg(bytes)
      : await parseEml(bytes);
  } catch (error) {
    if (error instanceof EmailFileError) throw error;
    throw new EmailFileError({ cause: error });
  }
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The message as a self-contained page for the PDF converter: a header block
 * and the body text, every value escaped, and nothing that names a resource.
 */
export function emailToHtml(email: ParsedEmail): string {
  const attachments = [
    ...email.attachments.map((attachment) => attachment.filename),
    ...email.skippedAttachments.map((name) => `${name} (not imported)`),
  ].join(", ");
  const rows = [
    ["From", email.from],
    ["To", email.to],
    ["Cc", email.cc],
    ["Date", email.date],
    ["Attachments", attachments],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<tr><td class="l">${label}:</td><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  // The subject is the table's first row, not a heading above it: LibreOffice
  // drops a leading heading or paragraph from an HTML page and leaves an
  // empty first page in its place.
  const subject = `<tr><td colspan="2" class="s">${escapeHtml(
    email.subject || "(no subject)",
  )}</td></tr>`;
  const body = email.text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
body { font-family: "Liberation Sans", Arial, sans-serif; font-size: 11pt; }
td { padding: 1pt 8pt 1pt 0; vertical-align: top; }
td.s { font-size: 15pt; font-weight: bold; padding-bottom: 6pt; }
td.l { font-weight: bold; white-space: nowrap; }
p { margin: 0 0 8pt 0; }
</style></head>
<body>
<table>${subject}${rows}</table>
<hr>
${body}
</body></html>
`;
}
