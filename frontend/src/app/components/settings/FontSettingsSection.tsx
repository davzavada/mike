"use client";

import { useSyncExternalStore } from "react";
import { GlassCardUI } from "@mike/ui";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsSelectRow } from "@/app/components/settings/SettingsSelectRow";
import {
    INTERFACE_FONT_OPTIONS,
    READING_FONT_OPTIONS,
    getFontPreference,
    saveFontPreference,
    subscribeFontPreference,
    type FontPreference,
} from "@/app/lib/fontPreference";

/**
 * Settings → Appearance: the two typefaces Mike is shown in. A choice applies
 * at once and is remembered in this browser (lib/fontPreference.ts).
 */
export function FontSettingsSection() {
    // The server render cannot see this browser's storage: it renders the
    // rows' loading state, and the saved choice appears on hydration.
    const preference = useSyncExternalStore<FontPreference | null>(
        subscribeFontPreference,
        getFontPreference,
        () => null,
    );
    const change = saveFontPreference;

    return (
        <section className="space-y-3">
            <SettingsHeading id="fonts">Fonts</SettingsHeading>
            <GlassCardUI>
                <SettingsSelectRow
                    id="reading-font"
                    label="Reading font"
                    options={[...READING_FONT_OPTIONS]}
                    value={preference?.reading ?? null}
                    onChange={(value) =>
                        preference &&
                        change({
                            ...preference,
                            reading: value as FontPreference["reading"],
                        })
                    }
                />
                <SettingsSelectRow
                    id="interface-font"
                    label="Interface font"
                    options={[...INTERFACE_FONT_OPTIONS]}
                    value={preference?.interface ?? null}
                    onChange={(value) =>
                        preference &&
                        change({
                            ...preference,
                            interface: value as FontPreference["interface"],
                        })
                    }
                />
            </GlassCardUI>
        </section>
    );
}
