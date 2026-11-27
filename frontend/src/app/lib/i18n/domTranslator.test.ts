import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, translatePage } from "./domTranslator";

const translate = createTranslator({
    Save: "Uložit",
    "Saving…": "Ukládání…",
    Project: "Projekt",
    "Search documents": "Hledat dokumenty",
    "% used": "% využito",
    "{1} documents": {
        one: "{1} dokument",
        few: "{1} dokumenty",
        other: "{1} dokumentů",
    },
    "Delete {1}?": "Smazat {1}?",
    "{1} of {2}": "{1} z {2}",
    "delete {1} project{2}": {
        one: "smazat {1} projekt",
        few: "smazat {1} projekty",
        other: "smazat {1} projektů",
    },
    "Shared by {2} on {1}": "Sdílel(a) {2} dne {1}",
});

describe("createTranslator", () => {
    it("translates a known string and leaves an unknown one alone", () => {
        expect(translate("Save")).toBe("Uložit");
        expect(translate("Something else")).toBeNull();
        expect(translate("   ")).toBeNull();
    });

    it("keeps the space that separates a node from its neighbours", () => {
        expect(translate(" Save ")).toBe(" Uložit ");
        expect(translate("Search\n   documents")).toBe("Hledat dokumenty");
    });

    it("picks the Czech plural form from the count", () => {
        expect(translate("1 documents")).toBe("1 dokument");
        expect(translate("3 documents")).toBe("3 dokumenty");
        expect(translate("5 documents")).toBe("5 dokumentů");
        expect(translate("0 documents")).toBe("0 dokumentů");
        // An English ending the Czech forms leave out, or no ending at all.
        expect(translate("delete 3 projects")).toBe("smazat 3 projekty");
        expect(translate("delete 1 project")).toBe("smazat 1 projekt");
        // A folder's name, not a count.
        expect(translate("Signed documents")).toBeNull();
    });

    it("places interpolated values, translating one that is itself known", () => {
        expect(translate("Delete Annual report.pdf?")).toBe(
            "Smazat Annual report.pdf?",
        );
        expect(translate("Delete Project?")).toBe("Smazat Projekt?");
        expect(translate("Shared by Jana on 3 May")).toBe(
            "Sdílel(a) Jana dne 3 May",
        );
    });

    it("lets a pattern that is mostly values match numbers only", () => {
        expect(translate("3 of 10")).toBe("3 z 10");
        // A title, not a count: it must not become "Statement z Work".
        expect(translate("Statement of Work")).toBeNull();
    });
});

describe("translatePage", () => {
    let stop: (() => void) | undefined;

    afterEach(() => {
        stop?.();
        stop = undefined;
        document.body.innerHTML = "";
    });

    const start = (html: string) => {
        document.body.innerHTML = html;
        stop = translatePage(document.body, {
            translate,
            brand: { source: "Mike", shown: "Michal", within: "h1" },
        });
    };
    // MutationObserver callbacks run as microtasks.
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("translates text and the attributes a person reads", () => {
        start(
            '<button title="Save">Save</button><input placeholder="Search documents" aria-label="Search documents">',
        );
        const button = document.querySelector("button")!;
        expect(button.textContent).toBe("Uložit");
        expect(button.title).toBe("Uložit");
        const input = document.querySelector("input")!;
        expect(input.placeholder).toBe("Hledat dokumenty");
        expect(input.getAttribute("aria-label")).toBe("Hledat dokumenty");
    });

    it("keeps up with what is rendered afterwards", async () => {
        start("<button>Save</button>");
        const button = document.querySelector("button")!;
        // React writing a new text into the node it created.
        button.firstChild!.nodeValue = "Saving…";
        await settled();
        expect(button.textContent).toBe("Ukládání…");

        const added = document.createElement("p");
        added.textContent = "2 documents";
        document.body.append(added);
        await settled();
        expect(added.textContent).toBe("2 dokumenty");

        button.setAttribute("title", "Save");
        await settled();
        expect(button.title).toBe("Uložit");
    });

    it("leaves what a person or a model wrote untouched", () => {
        start(
            '<div class="prose"><p>Save</p></div><p class="whitespace-pre-wrap">Save</p><textarea>Save</textarea><pre>Save</pre><div contenteditable="true">Save</div><p data-no-translate>Save</p>',
        );
        for (const node of document.body.children) {
            expect(node.textContent).toBe("Save");
        }
    });

    it("renames the product in its heading, not a person called Mike", () => {
        start("<h1><span>Mike</span></h1><p>Mike</p>");
        expect(document.querySelector("h1")!.textContent).toBe("Michal");
        expect(document.querySelector("p")!.textContent).toBe("Mike");
    });

    it("waits for React to take a server-rendered part over", async () => {
        vi.useFakeTimers();
        // The marks React leaves: one on the page it renders, one on each
        // element it has checked or created.
        const mark = (node: object, key: string) =>
            Object.defineProperty(node, key, {
                value: {},
                enumerable: true,
                configurable: true,
            });
        mark(document, "__reactContainer$test");
        try {
            document.body.innerHTML =
                '<button id="ready">Save</button><button id="later" title="Save">Save</button>';
            mark(document.querySelector("#ready")!, "__reactFiber$test");
            stop = translatePage(document.body, { translate });
            expect(document.querySelector("#ready")!.textContent).toBe("Uložit");
            const later = document.querySelector<HTMLElement>("#later")!;
            expect(later.textContent).toBe("Save");
            expect(later.title).toBe("Save");

            // React reaches it without changing the page; the next look
            // finds it ready.
            mark(later, "__reactFiber$test");
            await vi.advanceTimersByTimeAsync(60);
            expect(later.textContent).toBe("Uložit");
            expect(later.title).toBe("Uložit");
        } finally {
            vi.useRealTimers();
            delete (document as unknown as Record<string, unknown>)[
                "__reactContainer$test"
            ];
        }
    });

    it("puts the English back when it stops", async () => {
        start('<button title="Save">Save</button><p>4 documents</p>');
        stop!();
        stop = undefined;
        expect(document.querySelector("button")!.textContent).toBe("Save");
        expect(document.querySelector("button")!.title).toBe("Save");
        expect(document.querySelector("p")!.textContent).toBe("4 documents");

        // And no longer follows the page.
        document.querySelector("p")!.firstChild!.nodeValue = "Save";
        await settled();
        expect(document.querySelector("p")!.textContent).toBe("Save");
    });
});
