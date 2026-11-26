import { extractDocxBodyText } from "../docxTrackedChanges";
import { extractPdfTextForIndex } from "../pdfText";
import { docxToPdf } from "../convert";
import { extractPresentationText } from "../officeText";
import { spreadsheetToLLMText } from "../spreadsheet";
import {
  documentSuffix,
  isEmailDocumentType,
  isSpreadsheetDocumentType,
  requiresLibreOfficeTextExtraction,
} from "../documentTypes";
import { parseEmailFile } from "../emailFile";

/**
 * An email's text: its headers and body, then the text of each attachment
 * under a line naming it. The order matches the email's preview
 * (lib/emailDocument.ts), which shows the same parts as pages.
 */
async function extractEmailText(raw: ArrayBuffer, type: string) {
  const email = await parseEmailFile(`message.${type}`, Buffer.from(raw));
  const header = [
    ["Subject", email.subject],
    ["From", email.from],
    ["To", email.to],
    ["Cc", email.cc],
    ["Date", email.date],
    [
      "Attachments",
      [
        ...email.attachments.map((attachment) => attachment.filename),
        ...email.skippedAttachments.map((name) => `${name} (not read)`),
      ].join(", "),
    ],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
  const sections = [`${header}\n\n${email.text}`.trim()];
  for (const attachment of email.attachments) {
    const content = attachment.content;
    try {
      const { text } = await extractDocumentText(
        content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer,
        documentSuffix(attachment.filename),
      );
      sections.push(`--- Attachment: ${attachment.filename} ---\n${text.trim()}`);
    } catch {
      // One unreadable attachment must not cost the message and the rest.
      sections.push(
        `--- Attachment: ${attachment.filename} ---\n(This attachment could not be read.)`,
      );
    }
  }
  return { text: sections.join("\n\n"), textlessPageCount: null };
}

/** Complete text, using the same accepted DOCX view as the edit matcher. */
export async function extractDocumentText(raw: ArrayBuffer, fileType: string) {
  const type = fileType.toLowerCase();
  if (type === "pdf") return extractPdfTextForIndex(raw);
  if (isEmailDocumentType(type)) return extractEmailText(raw, type);
  if (requiresLibreOfficeTextExtraction(type)) {
    const pdf = await docxToPdf(Buffer.from(raw));
    return extractPdfTextForIndex(Uint8Array.from(pdf).buffer);
  }
  let text: string;
  if (type === "docx") {
    text = await extractDocxBodyText(Buffer.from(raw));
    if (!text) text = (await (await import("mammoth")).extractRawText({ buffer: Buffer.from(raw) })).value;
  } else if (isSpreadsheetDocumentType(type)) {
    text = spreadsheetToLLMText(Buffer.from(raw));
  } else if (type === "pptx") {
    text = await extractPresentationText(Buffer.from(raw));
  } else {
    throw new Error("document_text_unsupported_format");
  }
  return { text, textlessPageCount: null };
}
