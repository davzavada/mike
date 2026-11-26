import { describe, expect, it, vi } from "vitest";
import {
    expandEmailFiles,
    isEmailFile,
    type ConvertedEmail,
} from "./emailUpload";

const file = (name: string) => new File(["x"], name);
const b64 = (text: string) => btoa(text);

const converted = (base: string): ConvertedEmail => ({
    files: [
        {
            filename: `${base}.pdf`,
            content_type: "application/pdf",
            data: b64("%PDF-message"),
        },
        {
            filename: `${base} - lease.docx`,
            content_type: "application/msword",
            data: b64("attachment"),
        },
    ],
    skipped_attachments: ["logo.png"],
});

describe("isEmailFile", () => {
    it.each([
        ["note.eml", true],
        ["Note.MSG", true],
        ["note.eml.pdf", false],
        ["contract.pdf", false],
        ["eml", false],
    ])("%s → %s", (name, expected) => {
        expect(isEmailFile(file(name))).toBe(expected);
    });
});

describe("expandEmailFiles", () => {
    it("leaves a batch without emails untouched, converting nothing", async () => {
        const convert = vi.fn();
        const batch = [{ file: file("a.pdf"), clientId: "1" }];
        await expect(
            expandEmailFiles(batch, convert, { includeAttachments: true }),
        ).resolves.toBe(batch);
        expect(convert).not.toHaveBeenCalled();
    });

    it("puts the message PDF in the email's place and its attachments after it", async () => {
        const convert = vi.fn(async (email: File) =>
            converted(email.name.replace(/\.eml$/, "")),
        );
        const result = await expandEmailFiles(
            [
                { file: file("first.pdf"), clientId: "1" },
                { file: file("Re lease.eml"), clientId: "2", folderId: "f" },
                { file: file("last.docx"), clientId: "3" },
            ],
            convert,
            { includeAttachments: true },
        );
        expect(
            result.map((input) => [input.file.name, input.clientId, input.folderId]),
        ).toEqual([
            ["first.pdf", "1", undefined],
            // Same client id and folder: the caller's placeholder completes.
            ["Re lease.pdf", "2", "f"],
            ["Re lease - lease.docx", undefined, "f"],
            ["last.docx", "3", undefined],
        ]);
        expect(result[1].file.type).toBe("application/pdf");
        await expect(result[1].file.text()).resolves.toBe("%PDF-message");
    });

    it("keeps one file per email where attachments are not wanted", async () => {
        const result = await expandEmailFiles(
            [{ file: file("note.msg"), clientId: "1" }],
            async () => converted("note"),
            { includeAttachments: false },
        );
        expect(result.map((input) => input.file.name)).toEqual(["note.pdf"]);
    });

    it("passes the cancel signal on and fails the batch when conversion fails", async () => {
        const controller = new AbortController();
        const refusal = new Error("This email file could not be read.");
        const convert = vi.fn(async () => {
            throw refusal;
        });
        await expect(
            expandEmailFiles([{ file: file("bad.eml") }], convert, {
                includeAttachments: true,
                signal: controller.signal,
            }),
        ).rejects.toBe(refusal);
        expect(convert).toHaveBeenCalledWith(
            expect.any(File),
            controller.signal,
        );
    });
});
