"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Image from "next/image";

import { PillButtonUI } from "@mike/ui";
import { ClaudeSubscriptionUsage } from "@/app/components/settings/ClaudeSubscriptionUsage";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    completeClaudeSubscriptionLogin,
    disconnectClaudeSubscription,
    getClaudeSubscription,
    isMfaRequiredError,
    startClaudeSubscriptionLogin,
    type ClaudeSubscriptionStatus,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";

type Action = "connect" | "complete" | "disconnect";

/**
 * Settings → API Keys: the person's own Claude subscription.
 *
 * Signing in happens at Anthropic. Mike shows the link Claude Code offers
 * and passes the confirmation code back to it; it never sees a password and
 * does not keep the code. Renders nothing on a deployment without the
 * feature, so the page looks exactly as it does upstream.
 */
export function ClaudeSubscriptionSection() {
    const { reloadProfile } = useUserProfile();
    const [status, setStatus] = useState<ClaudeSubscriptionStatus | null>(null);
    const [busy, setBusy] = useState<Action | null>(null);
    const [code, setCode] = useState("");
    const [pendingMfa, setPendingMfa] = useState<Action | null>(null);
    const codeId = useId();

    useEffect(() => {
        let cancelled = false;
        getClaudeSubscription()
            .then((next) => {
                if (!cancelled) setStatus(next);
            })
            // An older or differently configured server has no such route:
            // the section simply stays hidden.
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const run = useCallback(
        async (action: Action) => {
            setBusy(action);
            try {
                const next =
                    action === "connect"
                        ? await startClaudeSubscriptionLogin()
                        : action === "complete"
                          ? await completeClaudeSubscriptionLogin(code.trim())
                          : await disconnectClaudeSubscription();
                setStatus(next);
                if (action !== "connect") {
                    setCode("");
                    // The model pickers read availability from the profile.
                    await reloadProfile();
                }
            } catch (error) {
                if (isMfaRequiredError(error)) setPendingMfa(action);
                else
                    notifyError(error, {
                        action:
                            action === "disconnect"
                                ? "disconnect your Claude subscription"
                                : "connect your Claude subscription",
                    });
            } finally {
                setBusy(null);
            }
        },
        [code, reloadProfile],
    );

    if (!status?.available) return null;

    const signingIn = !status.connected && status.loginUrl !== null;
    const detail = status.connected
        ? [status.account, status.plan ? `${status.plan} plan` : null]
              .filter(Boolean)
              .join(" · ") || "Connected"
        : "Not connected";

    return (
        <section
            aria-labelledby="byok-claude-subscription"
            className="@container space-y-3"
        >
            <SettingsHeading id="byok-claude-subscription">
                Claude Subscription
            </SettingsHeading>
            <SettingsDescription>
                Run Claude models on your own Claude plan instead of an API
                key. You sign in at Anthropic; usage counts against your
                plan&apos;s limits. A saved Anthropic API key takes precedence.
            </SettingsDescription>
            <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">
                <ConnectorCard
                    kind="subscription"
                    name="Claude"
                    detail={detail}
                    icon={
                        <Image
                            src="/icons/providers/anthropic.svg"
                            alt=""
                            width={28}
                            height={28}
                            className="dark:invert"
                        />
                    }
                    action={
                        status.connected ? (
                            <PillButtonUI
                                tone="white"
                                size="sm"
                                loading={busy === "disconnect"}
                                disabled={busy !== null}
                                onClick={() => void run("disconnect")}
                            >
                                Disconnect
                            </PillButtonUI>
                        ) : (
                            <PillButtonUI
                                tone="blue"
                                size="sm"
                                loading={busy === "connect"}
                                disabled={busy !== null}
                                onClick={() => void run("connect")}
                            >
                                {signingIn ? "Restart" : "Connect"}
                            </PillButtonUI>
                        )
                    }
                />
            </div>
            {status.connected ? <ClaudeSubscriptionUsage /> : null}
            {signingIn ? (
                <form
                    className="max-w-xl space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (code.trim()) void run("complete");
                    }}
                >
                    <SettingsDescription>
                        1.{" "}
                        <a
                            href={status.loginUrl ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-blue-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                            Open the Claude sign-in page
                        </a>{" "}
                        and approve access. 2. Copy the code it shows and
                        paste it here.
                    </SettingsDescription>
                    <div>
                        <FieldLabel htmlFor={codeId}>Sign-in code</FieldLabel>
                        <div className="flex flex-wrap items-center gap-3">
                            <FormTextInput
                                id={codeId}
                                className="min-w-0 flex-[1_0_12rem]"
                                value={code}
                                onChange={(event) => setCode(event.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={busy !== null}
                            />
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="sm"
                                loading={busy === "complete"}
                                disabled={busy !== null || !code.trim()}
                            >
                                Finish sign-in
                            </PillButtonUI>
                        </div>
                    </div>
                </form>
            ) : null}
            <MfaVerificationPopup
                open={pendingMfa !== null}
                onCancel={() => setPendingMfa(null)}
                onVerified={() => {
                    const action = pendingMfa;
                    setPendingMfa(null);
                    if (action) void run(action);
                }}
            />
        </section>
    );
}
