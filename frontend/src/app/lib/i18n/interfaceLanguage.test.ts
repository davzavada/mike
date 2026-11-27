import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cs.json", () => ({ default: { Settings: "Nastavení" } }));

import {
    applyInterfaceLanguage,
    getInterfaceLanguage,
    loadInterfaceLanguage,
    resetInterfaceLanguage,
    saveInterfaceLanguage,
    subscribeInterfaceLanguage,
} from "./interfaceLanguage";

const KEY = "mike.interfaceLanguage";

beforeEach(() => {
    window.localStorage.clear();
    resetInterfaceLanguage();
    document.documentElement.lang = "en";
    document.body.innerHTML = "<h1>Mike</h1><p>Settings</p>";
});

afterEach(() => {
    resetInterfaceLanguage();
    document.body.innerHTML = "";
});

const paragraph = () => document.querySelector("p")!.textContent;

describe("interface language", () => {
    it("is English until a language is chosen, and for a value it does not know", () => {
        expect(loadInterfaceLanguage()).toBe("en");
        window.localStorage.setItem(KEY, "xx");
        expect(loadInterfaceLanguage()).toBe("en");
    });

    it("shows the page in Czech, under the name Michal", async () => {
        await applyInterfaceLanguage("cs");
        expect(document.documentElement.lang).toBe("cs");
        expect(paragraph()).toBe("Nastavení");
        expect(document.querySelector("h1")!.textContent).toBe("Michal");
    });

    it("goes back to English at once", async () => {
        await applyInterfaceLanguage("cs");
        await applyInterfaceLanguage("en");
        expect(document.documentElement.lang).toBe("en");
        expect(paragraph()).toBe("Settings");
        expect(document.querySelector("h1")!.textContent).toBe("Mike");
    });

    it("does not apply a dictionary that arrives after switching back", async () => {
        const czech = applyInterfaceLanguage("cs");
        const english = applyInterfaceLanguage("en");
        await Promise.all([czech, english]);
        expect(paragraph()).toBe("Settings");
    });

    it("remembers the choice in this browser and tells subscribers", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeInterfaceLanguage(listener);
        saveInterfaceLanguage("cs");
        expect(window.localStorage.getItem(KEY)).toBe("cs");
        expect(getInterfaceLanguage()).toBe("cs");
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();

        resetInterfaceLanguage();
        expect(getInterfaceLanguage()).toBe("cs");
    });
});
