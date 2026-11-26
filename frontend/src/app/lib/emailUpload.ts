// Email files (.eml, Outlook .msg) in an upload batch.
//
// Mike stores no email document type. Before a batch is uploaded, each email
// in it is sent to the backend, which returns ordinary files: a PDF of the
// message and each attachment of a supported type. Those take the email's
// place in the batch, so the rest of the upload, and everything after it,
// sees only documents it already understands.
import type { UploadSessionInput } from "@mike/client";

const EMAIL_EXTENSIONS = new Set(["eml", "msg"]);

export function isEmailFile(file: File): boolean {
    const extension = file.name.split(".").pop()?.toLowerCase();
    return !!extension && file.name.includes(".") && EMAIL_EXTENSIONS.has(extension);
}

/** What POST /upload-sessions/email-conversion answers. */
export type ConvertedEmail = {
    files: Array<{ filename: string; content_type: string; data: string }>;
    skipped_attachments: string[];
};

function fileFromBase64(entry: ConvertedEmail["files"][number]): File {
    const binary = atob(entry.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], entry.filename, { type: entry.content_type });
}

/**
 * Replace each email in a batch with the files it converts to. The message
 * PDF keeps the email's place, client id and folder, so a caller tracking the
 * upload by id sees it complete. Attachments follow it into the same folder
 * as new entries; `includeAttachments` is false where a batch must stay one
 * file per input (a new version of an existing document).
 */
export async function expandEmailFiles(
    files: UploadSessionInput[],
    convert: (file: File, signal?: AbortSignal) => Promise<ConvertedEmail>,
    options: { includeAttachments: boolean; signal?: AbortSignal },
): Promise<UploadSessionInput[]> {
    if (!files.some((input) => isEmailFile(input.file))) return files;
    const expanded: UploadSessionInput[] = [];
    for (const input of files) {
        if (!isEmailFile(input.file)) {
            expanded.push(input);
            continue;
        }
        // One at a time: each conversion starts a document converter.
        const converted = await convert(input.file, options.signal);
        const [message, ...attachments] = converted.files.map(fileFromBase64);
        if (!message) continue;
        expanded.push({ ...input, file: message });
        if (!options.includeAttachments) continue;
        for (const attachment of attachments) {
            expanded.push({ file: attachment, folderId: input.folderId });
        }
    }
    return expanded;
}
