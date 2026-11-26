// Which typefaces this browser shows Mike in.
//
// Mike has two type slots (docs/design-system.md): the interface face
// (Inter: menus, tables, controls) and the reading face (EB Garamond:
// answers, documents, display headings). A choice here sets a data attribute
// on <html>; globals.css redefines the slot's CSS variable under it. Nothing
// is downloaded: the alternatives are the other bundled face or fonts already
// on the person's device.
//
// The choice is kept in this browser only. It is a display preference, like
// the sidebar's width, and needs no account setting behind it.

export const READING_FONT_OPTIONS = [
    {
        value: "default",
        label: "EB Garamond",
        description: "The default serif for answers, documents and headings.",
    },
    {
        value: "inter",
        label: "Inter",
        description: "The interface's sans-serif for answers and documents too.",
    },
    {
        value: "system-serif",
        label: "System serif",
        description: "Your device's own serif, such as New York or Georgia.",
    },
    {
        value: "system-sans",
        label: "System sans-serif",
        description: "Your device's own interface font for answers and documents.",
    },
] as const;

export const INTERFACE_FONT_OPTIONS = [
    {
        value: "default",
        label: "Inter",
        description: "The default sans-serif for menus, tables and controls.",
    },
    {
        value: "system-sans",
        label: "System sans-serif",
        description: "Your device's own interface font, such as San Francisco.",
    },
    {
        value: "system-serif",
        label: "System serif",
        description: "Your device's own serif for menus, tables and controls.",
    },
] as const;

export type ReadingFont = (typeof READING_FONT_OPTIONS)[number]["value"];
export type InterfaceFont = (typeof INTERFACE_FONT_OPTIONS)[number]["value"];
export type FontPreference = { reading: ReadingFont; interface: InterfaceFont };

export const DEFAULT_FONT_PREFERENCE: FontPreference = {
    reading: "default",
    interface: "default",
};

const STORAGE_KEY = "mike.fontPreference";

function oneOf<T extends string>(
    options: readonly { value: T }[],
    value: unknown,
): T | null {
    return options.find((option) => option.value === value)?.value ?? null;
}

/** The saved choice, or the defaults when nothing usable is saved. */
export function loadFontPreference(): FontPreference {
    try {
        const saved = JSON.parse(
            window.localStorage.getItem(STORAGE_KEY) ?? "null",
        ) as Partial<Record<keyof FontPreference, unknown>> | null;
        return {
            reading:
                oneOf(READING_FONT_OPTIONS, saved?.reading) ??
                DEFAULT_FONT_PREFERENCE.reading,
            interface:
                oneOf(INTERFACE_FONT_OPTIONS, saved?.interface) ??
                DEFAULT_FONT_PREFERENCE.interface,
        };
    } catch {
        // Private windows and blocked storage read as "nothing saved".
        return DEFAULT_FONT_PREFERENCE;
    }
}

/** Show the choice now. A default removes its attribute, restoring the theme. */
export function applyFontPreference(preference: FontPreference): void {
    if (typeof document === "undefined") return;
    const { dataset } = document.documentElement;
    if (preference.reading === "default") delete dataset.readingFont;
    else dataset.readingFont = preference.reading;
    if (preference.interface === "default") delete dataset.interfaceFont;
    else dataset.interfaceFont = preference.interface;
}

// The current choice as a store React can subscribe to
// (useSyncExternalStore): read from storage once, then kept here.
let current: FontPreference | null = null;
const listeners = new Set<() => void>();

export function subscribeFontPreference(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getFontPreference(): FontPreference {
    return (current ??= loadFontPreference());
}

/** Show the choice and remember it in this browser. */
export function saveFontPreference(preference: FontPreference): void {
    current = preference;
    applyFontPreference(preference);
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
    } catch {
        // Still applied for this page; it just will not survive a reload.
    }
    for (const listener of listeners) listener();
}

/** Forget the in-memory copy, so the next read comes from storage (tests). */
export function resetFontPreferenceCache(): void {
    current = null;
}
