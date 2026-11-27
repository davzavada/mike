import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/i18n/cs.json", () => ({ default: {} }));

import { resetInterfaceLanguage } from "@/app/lib/i18n/interfaceLanguage";
import { LanguageSettingsSection } from "./LanguageSettingsSection";

describe("LanguageSettingsSection", () => {
    beforeEach(() => {
        window.localStorage.clear();
        resetInterfaceLanguage();
    });

    it("shows English until another language is chosen", () => {
        render(<LanguageSettingsSection />);
        expect(
            screen.getByText("The language the interface is written in."),
        ).toBeInTheDocument();
    });

    it("switches to Czech and remembers it", async () => {
        const user = userEvent.setup();
        render(<LanguageSettingsSection />);
        await user.click(
            screen.getByRole("button", { name: /Interface language/ }),
        );
        await user.click(
            await screen.findByRole("menuitemradio", { name: /Čeština/ }),
        );
        expect(window.localStorage.getItem("mike.interfaceLanguage")).toBe(
            "cs",
        );
        expect(
            await screen.findByText("Czech. The product is called Michal."),
        ).toBeInTheDocument();
    });
});
