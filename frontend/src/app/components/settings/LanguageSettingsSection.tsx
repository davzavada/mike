"use client";

import { useSyncExternalStore } from "react";
import { GlassCardUI } from "@mike/ui";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsSelectRow } from "@/app/components/settings/SettingsSelectRow";
import {
    INTERFACE_LANGUAGE_OPTIONS,
    getInterfaceLanguage,
    saveInterfaceLanguage,
    subscribeInterfaceLanguage,
    type InterfaceLanguage,
} from "@/app/lib/i18n/interfaceLanguage";

/**
 * Settings → Appearance: the language the interface is shown in. A choice
 * applies at once and is remembered in this browser
 * (lib/i18n/interfaceLanguage.ts). The language of the assistant's answers
 * is set separately, under Personalisation.
 */
export function LanguageSettingsSection() {
    // The server render cannot see this browser's storage: it renders the
    // row's loading state, and the saved choice appears on hydration.
    const language = useSyncExternalStore<InterfaceLanguage | null>(
        subscribeInterfaceLanguage,
        getInterfaceLanguage,
        () => null,
    );

    return (
        <section className="space-y-3">
            <SettingsHeading id="language">Language</SettingsHeading>
            <GlassCardUI>
                <SettingsSelectRow
                    id="interface-language"
                    label="Interface language"
                    options={[...INTERFACE_LANGUAGE_OPTIONS]}
                    value={language}
                    onChange={(value) =>
                        saveInterfaceLanguage(value as InterfaceLanguage)
                    }
                />
            </GlassCardUI>
        </section>
    );
}
