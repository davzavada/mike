import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_FONT_PREFERENCE,
    applyFontPreference,
    getFontPreference,
    loadFontPreference,
    resetFontPreferenceCache,
    saveFontPreference,
    subscribeFontPreference,
} from "./fontPreference";

const KEY = "mike.fontPreference";

describe("font preference", () => {
    beforeEach(() => {
        window.localStorage.clear();
        resetFontPreferenceCache();
        applyFontPreference(DEFAULT_FONT_PREFERENCE);
    });

    it("starts from the defaults, with nothing set on the document", () => {
        expect(loadFontPreference()).toEqual(DEFAULT_FONT_PREFERENCE);
        expect(document.documentElement.dataset.readingFont).toBeUndefined();
        expect(document.documentElement.dataset.interfaceFont).toBeUndefined();
    });

    it("applies a choice at once and remembers it", () => {
        saveFontPreference({ reading: "inter", interface: "system-sans" });
        expect(document.documentElement.dataset.readingFont).toBe("inter");
        expect(document.documentElement.dataset.interfaceFont).toBe(
            "system-sans",
        );
        resetFontPreferenceCache();
        expect(getFontPreference()).toEqual({
            reading: "inter",
            interface: "system-sans",
        });
    });

    it("going back to a default removes the attribute", () => {
        saveFontPreference({ reading: "system-serif", interface: "default" });
        saveFontPreference({ reading: "default", interface: "default" });
        expect(document.documentElement.dataset.readingFont).toBeUndefined();
    });

    it.each([
        "not json",
        JSON.stringify(null),
        JSON.stringify({ reading: "comic-sans", interface: 7 }),
        JSON.stringify(["inter"]),
    ])("reads the unusable saved value %j as the defaults", (saved) => {
        window.localStorage.setItem(KEY, saved);
        expect(loadFontPreference()).toEqual(DEFAULT_FONT_PREFERENCE);
    });

    it("keeps the valid half of a partly valid saved value", () => {
        window.localStorage.setItem(
            KEY,
            JSON.stringify({ reading: "inter", interface: "wingdings" }),
        );
        expect(loadFontPreference()).toEqual({
            reading: "inter",
            interface: "default",
        });
    });

    it("still applies a choice when storage refuses to save it", () => {
        const setItem = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(() => {
                throw new DOMException("denied", "SecurityError");
            });
        saveFontPreference({ reading: "inter", interface: "default" });
        expect(document.documentElement.dataset.readingFont).toBe("inter");
        expect(getFontPreference().reading).toBe("inter");
        setItem.mockRestore();
    });

    it("tells subscribers about a change, until they unsubscribe", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeFontPreference(listener);
        saveFontPreference({ reading: "inter", interface: "default" });
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        saveFontPreference({ reading: "default", interface: "default" });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
