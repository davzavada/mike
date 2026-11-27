// The language this browser shows the interface in.
//
// English is the language the interface is written in. Czech is a
// dictionary applied to the rendered page (domTranslator.ts), under which
// the product is called Michal. Like the font choice (lib/fontPreference.ts),
// the choice is a display preference kept in this browser only.
//
// This sets the interface's language. The language the assistant answers in
// is a separate, per-account setting (Settings → Personalisation).
import {
    createTranslator,
    translatePage,
    type Dictionary,
} from "./domTranslator";

export const INTERFACE_LANGUAGE_OPTIONS = [
    {
        value: "en",
        label: "English",
        description: "The language the interface is written in.",
    },
    {
        value: "cs",
        label: "Čeština",
        description: "Czech. The product is called Michal.",
    },
] as const;

export type InterfaceLanguage =
    (typeof INTERFACE_LANGUAGE_OPTIONS)[number]["value"];

export const DEFAULT_INTERFACE_LANGUAGE: InterfaceLanguage = "en";

const STORAGE_KEY = "mike.interfaceLanguage";

// Where "Mike" alone is the product's name: the logo and the sidebar's
// heading. Elsewhere a lone "Mike" may be a person.
const BRAND = {
    source: "Mike",
    shown: "Michal",
    within: 'h1, [data-slot="sidebar-heading"]',
};

const DICTIONARIES: Record<
    Exclude<InterfaceLanguage, "en">,
    () => Promise<Dictionary>
> = {
    // Loaded only for a browser that chose it.
    cs: async () => (await import("./cs.json")).default as Dictionary,
};

function isLanguage(value: unknown): value is InterfaceLanguage {
    return INTERFACE_LANGUAGE_OPTIONS.some((option) => option.value === value);
}

/** The saved choice, or English when nothing usable is saved. */
export function loadInterfaceLanguage(): InterfaceLanguage {
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        return isLanguage(saved) ? saved : DEFAULT_INTERFACE_LANGUAGE;
    } catch {
        // Private windows and blocked storage read as "nothing saved".
        return DEFAULT_INTERFACE_LANGUAGE;
    }
}

let stop: (() => void) | null = null;
// Each call supersedes the one before it: a dictionary that arrives after
// the person switched back is not applied.
let request = 0;

/** Show the interface in `language` from now on. */
export async function applyInterfaceLanguage(
    language: InterfaceLanguage,
): Promise<void> {
    if (typeof document === "undefined") return;
    const mine = (request += 1);
    stop?.();
    stop = null;
    document.documentElement.lang = language;
    if (language === "en") return;
    const dictionary = await DICTIONARIES[language]();
    if (mine !== request) return;
    stop = translatePage(document.documentElement, {
        translate: createTranslator(dictionary),
        brand: BRAND,
    });
}

// The current choice as a store React can subscribe to
// (useSyncExternalStore): read from storage once, then kept here.
let current: InterfaceLanguage | null = null;
const listeners = new Set<() => void>();

export function subscribeInterfaceLanguage(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getInterfaceLanguage(): InterfaceLanguage {
    return (current ??= loadInterfaceLanguage());
}

/** Show the choice and remember it in this browser. */
export function saveInterfaceLanguage(language: InterfaceLanguage): void {
    current = language;
    void applyInterfaceLanguage(language);
    try {
        window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
        // Still applied for this page; it just will not survive a reload.
    }
    for (const listener of listeners) listener();
}

/** Forget the in-memory copy and stop translating (tests). */
export function resetInterfaceLanguage(): void {
    current = null;
    request += 1;
    stop?.();
    stop = null;
}
