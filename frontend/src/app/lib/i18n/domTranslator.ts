// Shows the interface in another language by translating the rendered page.
//
// The interface's strings are plain English in the components, most of them
// in files this fork shares with upstream. Rather than wrap every string in
// a translation call, the dictionary (cs.json) is applied to the DOM: a text
// node or attribute whose whole text is a known English string is replaced
// by its translation, and a MutationObserver keeps up with what React
// renders afterwards. A string without a translation stays English.
//
// React does not notice: it compares what it rendered last time with what it
// renders now, not with the DOM, and it keeps the nodes it created. When it
// does write a new English text, the observer translates that too.

export type PluralForms = { one: string; few: string; other: string };
export type Dictionary = Record<string, string | PluralForms>;
export type Translate = (text: string) => string | null;

const HOLE = /\{(\d+)\}/;
const HOLES = /\{(\d+)\}/g;

type Pattern = {
    regex: RegExp;
    /** The hole number each capture group stands for. */
    holes: string[];
    value: string | PluralForms;
};

const escapeRegex = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Czech: 1 dokument, 2–4 dokumenty, 5 dokumentů. */
function pluralForm(count: number, forms: PluralForms): string {
    if (count === 1) return forms.one;
    if (Number.isInteger(count) && count >= 2 && count <= 4) return forms.few;
    return forms.other;
}

function compilePattern(source: string, value: string | PluralForms): Pattern {
    const holes: string[] = [];
    const staticText = source.replace(HOLES, "");
    const NUMBER = "([\\d.,\\u00a0 ]*\\d%?)";
    // A pattern that is mostly holes ("{1} of {2}") would also match a title
    // such as "Statement of Work", so its holes only take numbers. So does
    // the count of a pattern with plural forms: "{1} documents" is "3
    // documents", not a folder called "Signed documents".
    const weak = staticText.replace(/[^A-Za-z]/g, "").length < 5;
    const counted = typeof value !== "string";
    const regex = source
        .split(HOLES)
        .map((part, index) => {
            if (index % 2 === 0) return escapeRegex(part);
            holes.push(part);
            return weak || (counted && holes.length === 1) ? NUMBER : "(.+?)";
        })
        .join("");
    return { regex: new RegExp(`^${regex}$`, "s"), holes, value };
}

/**
 * A function from an English string to its translation, or null when the
 * dictionary has none. A key with `{1}`, `{2}` is a pattern: each stands for
 * an interpolated value, which the translation places with the same marks.
 * A pattern's translation may give Czech plural forms; the first numeric
 * value picks the form.
 */
export function createTranslator(dictionary: Dictionary): Translate {
    const exact = new Map<string, string>();
    const patterns: Pattern[] = [];
    for (const [source, value] of Object.entries(dictionary)) {
        if (HOLE.test(source)) patterns.push(compilePattern(source, value));
        else if (typeof value === "string") exact.set(source, value);
    }
    // Longer static text first: the more specific pattern wins.
    patterns.sort((a, b) => b.regex.source.length - a.regex.source.length);
    const cache = new Map<string, string | null>();

    const lookup = (text: string): string | null => {
        const known = exact.get(text);
        if (known !== undefined) return known;
        for (const pattern of patterns) {
            const match = pattern.regex.exec(text);
            if (!match) continue;
            const values = new Map(
                pattern.holes.map((hole, index) => [hole, match[index + 1]]),
            );
            let template: string;
            if (typeof pattern.value === "string") template = pattern.value;
            else {
                const count = [...values.values()]
                    .map((value) => Number(value.replace(",", ".")))
                    .find((value) => !Number.isNaN(value));
                template = pluralForm(count ?? 0, pattern.value);
            }
            return template.replace(HOLES, (_, hole: string) => {
                const value = values.get(hole) ?? "";
                // An interpolated value may itself be a known string
                // ("Delete {1}" with "Project").
                return exact.get(value) ?? value;
            });
        }
        return null;
    };

    return (text) => {
        const core = text.trim();
        if (!core) return null;
        const normalized = core.replace(/\s+/g, " ");
        let translated = cache.get(normalized);
        if (translated === undefined) {
            translated = lookup(normalized);
            if (cache.size > 5000) cache.clear();
            cache.set(normalized, translated);
        }
        if (translated === null || translated === normalized) return null;
        // The node's own leading and trailing space separates it from its
        // neighbours ("42" + "% used"), so it is kept.
        const start = text.length - text.trimStart().length;
        const end = text.trimEnd().length;
        return text.slice(0, start) + translated + text.slice(end);
    };
}

const ATTRIBUTES = [
    "placeholder",
    "title",
    "aria-label",
    "aria-description",
    "alt",
] as const;

// What a person or a model wrote is never translated: answers, messages,
// documents, editors and code. Interface text lives outside these.
const CONTENT = [
    "script",
    "style",
    "noscript",
    "pre",
    "code",
    "textarea",
    '[contenteditable]:not([contenteditable="false"])',
    "[data-no-translate]",
    '[translate="no"]',
    ".prose",
    ".whitespace-pre-wrap",
    ".markdown-editor-content",
    ".docx-editor",
    ".fortune-container",
    ".textLayer",
    "[data-case-text-body]",
].join(", ");

type Shown = { source: string; shown: string };

const hasKey = (node: object, prefix: string) =>
    Object.keys(node).some((key) => key.startsWith(prefix));

/**
 * Whether React has taken this element over. On a server-rendered page React
 * checks each part's text against what it is about to render, part by part
 * and not all at once; text translated before that check would fail it and
 * make React throw the part away. React marks each element it has checked
 * or created, and only those are translated.
 */
const isReactOwned = (element: Element) => hasKey(element, "__reactFiber$");

/** A page React renders, as opposed to a document without React (tests). */
const isReactPage = (root: Node) => {
    const document = root.ownerDocument ?? (root as Document);
    return (
        hasKey(document, "__reactContainer$") ||
        (document.body !== null && hasKey(document.body, "__reactContainer$"))
    );
};

// How long parts React has not reached yet are looked at again.
const RETRY_DELAYS_MS = [50, 150, 400, 1000, 2000, 4000, 8000, 15000, 30000];

export type PageTranslatorOptions = {
    translate: Translate;
    /**
     * The product's name where it stands alone as a heading. Kept apart from
     * the dictionary so that a person called Mike keeps their name.
     */
    brand?: { source: string; shown: string; within: string };
};

/**
 * Translate `root` and keep it translated. Returns the function that stops
 * and puts every string back as React rendered it.
 */
export function translatePage(
    root: HTMLElement,
    { translate, brand }: PageTranslatorOptions,
): () => void {
    const texts = new Map<Text, Shown>();
    const attributes = new Map<Element, Map<string, Shown>>();
    const waitsForReact = isReactPage(root);
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Set when something was left for React to reach first.
    let leftForLater = false;

    const ready = (element: Element) => {
        if (!waitsForReact || isReactOwned(element)) return true;
        leftForLater = true;
        return false;
    };

    const translated = (text: string, element: Element): string | null => {
        if (brand && text.trim() === brand.source && element.closest(brand.within)) {
            return text.replace(brand.source, brand.shown);
        }
        return translate(text);
    };

    const textNode = (node: Text) => {
        const parent = node.parentElement;
        if (!parent || parent.closest(CONTENT) || !ready(parent)) return;
        const current = node.nodeValue ?? "";
        const record = texts.get(node);
        // Our own write, seen again by the observer.
        if (record?.shown === current) return;
        const next = translated(current, parent);
        if (next === null) {
            texts.delete(node);
            return;
        }
        texts.set(node, { source: current, shown: next });
        node.nodeValue = next;
    };

    const attribute = (element: Element, name: string) => {
        const current = element.getAttribute(name);
        const records = attributes.get(element);
        if (current === null) {
            records?.delete(name);
            return;
        }
        if (records?.get(name)?.shown === current) return;
        if (element.closest(CONTENT) || !ready(element)) return;
        const next = translated(current, element);
        if (next === null) {
            records?.delete(name);
            return;
        }
        const kept = records ?? new Map<string, Shown>();
        kept.set(name, { source: current, shown: next });
        attributes.set(element, kept);
        element.setAttribute(name, next);
    };

    const element = (node: Element) => {
        for (const name of ATTRIBUTES) {
            if (node.hasAttribute(name)) attribute(node, name);
        }
    };

    const subtree = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) return textNode(node as Text);
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        element(node as Element);
        const walker = document.createTreeWalker(
            node,
            NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        for (let next = walker.nextNode(); next; next = walker.nextNode()) {
            if (next.nodeType === Node.TEXT_NODE) textNode(next as Text);
            else element(next as Element);
        }
    };

    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === "characterData") {
                if (record.target.nodeType === Node.TEXT_NODE)
                    textNode(record.target as Text);
            } else if (record.type === "attributes") {
                if (record.attributeName)
                    attribute(record.target as Element, record.attributeName);
            } else {
                record.addedNodes.forEach(subtree);
            }
        }
        // Nodes React has dropped are forgotten with their originals.
        if (texts.size > 2000) {
            for (const node of texts.keys()) {
                if (!node.isConnected) texts.delete(node);
            }
        }
        if (attributes.size > 2000) {
            for (const node of attributes.keys()) {
                if (!node.isConnected) attributes.delete(node);
            }
        }
    });

    // React's check changes nothing in the page, so nothing announces that a
    // part has become ready: the page is read again, at growing intervals,
    // until nothing was left or the intervals run out.
    const scan = () => {
        leftForLater = false;
        subtree(root);
        if (!leftForLater || retry >= RETRY_DELAYS_MS.length) return;
        retryTimer = setTimeout(scan, RETRY_DELAYS_MS[retry]);
        retry += 1;
    };

    scan();
    observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...ATTRIBUTES],
    });

    return () => {
        clearTimeout(retryTimer);
        observer.disconnect();
        for (const [node, record] of texts) {
            if (node.nodeValue === record.shown) node.nodeValue = record.source;
        }
        for (const [node, records] of attributes) {
            for (const [name, record] of records) {
                if (node.getAttribute(name) === record.shown)
                    node.setAttribute(name, record.source);
            }
        }
        texts.clear();
        attributes.clear();
    };
}
