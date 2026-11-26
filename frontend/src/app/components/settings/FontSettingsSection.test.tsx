import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FONT_PREFERENCE,
    applyFontPreference,
    resetFontPreferenceCache,
} from "@/app/lib/fontPreference";
import { FontSettingsSection } from "./FontSettingsSection";

describe("FontSettingsSection", () => {
    beforeEach(() => {
        window.localStorage.clear();
        resetFontPreferenceCache();
        applyFontPreference(DEFAULT_FONT_PREFERENCE);
    });

    it("shows the current choice for both typefaces", () => {
        render(<FontSettingsSection />);
        expect(screen.getByRole("heading", { name: "Fonts" })).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Reading font" }),
        ).toHaveTextContent("EB Garamond");
        expect(
            screen.getByRole("button", { name: "Interface font" }),
        ).toHaveTextContent("Inter");
    });

    it("changes the reading font at once and remembers it", async () => {
        const user = userEvent.setup();
        render(<FontSettingsSection />);

        await user.click(screen.getByRole("button", { name: "Reading font" }));
        await user.click(
            await screen.findByRole("menuitemradio", { name: "Inter" }),
        );

        expect(document.documentElement.dataset.readingFont).toBe("inter");
        expect(
            screen.getByRole("button", { name: "Reading font" }),
        ).toHaveTextContent("Inter");
        expect(
            JSON.parse(window.localStorage.getItem("mike.fontPreference")!),
        ).toEqual({ reading: "inter", interface: "default" });
        // The other typeface is left as it was.
        expect(document.documentElement.dataset.interfaceFont).toBeUndefined();
    });

    it("opens on a previously saved choice", () => {
        window.localStorage.setItem(
            "mike.fontPreference",
            JSON.stringify({ reading: "default", interface: "system-sans" }),
        );
        render(<FontSettingsSection />);
        expect(
            screen.getByRole("button", { name: "Interface font" }),
        ).toHaveTextContent("System sans-serif");
    });
});
