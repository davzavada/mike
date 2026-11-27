"use client";

import { useEffect, useState } from "react";

import { PillButtonUI } from "@mike/ui";
import {
    SettingsDescription,
    SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import {
    getClaudeSubscriptionUsage,
    type ClaudeSubscriptionUsage as Usage,
    type ClaudeSubscriptionUsageWindow,
} from "@/app/lib/mikeApi";

function windowLabel(window: ClaudeSubscriptionUsageWindow): string {
    if (window.kind === "session") return "Current session (5 hours)";
    if (window.kind === "week") return "This week, all models";
    return `This week, ${window.model ?? "one model"}`;
}

/** "today at 14:30" within a day, "Mon 14:30" beyond it. */
function resetText(resetsAt: string | null, now: Date): string | null {
    if (!resetsAt) return null;
    const reset = new Date(resetsAt);
    if (Number.isNaN(reset.getTime())) return null;
    const time = reset.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
    });
    if (reset.toDateString() === now.toDateString()) {
        return `Resets today at ${time}`;
    }
    const day = reset.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
    });
    return `Resets ${day} at ${time}`;
}

function UsageRow({ window }: { window: ClaudeSubscriptionUsageWindow }) {
    const label = windowLabel(window);
    const percent = Math.round(window.usedPercent);
    const reset = resetText(window.resetsAt, new Date());
    return (
        <li className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="text-sm text-gray-700">{label}</span>
                <span className="text-sm tabular-nums text-gray-700">
                    {percent}% used
                </span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 overflow-hidden rounded-full bg-gray-200"
            >
                <div
                    className="h-full rounded-full bg-blue-600"
                    style={{ width: `${percent}%` }}
                />
            </div>
            {reset ? <p className="text-xs text-gray-500">{reset}</p> : null}
        </li>
    );
}

/** Two rows in the loaded layout: label and figure, bar, reset line. */
function UsageSkeleton() {
    return (
        <ul className="space-y-3" aria-hidden="true">
            {[0, 1].map((row) => (
                <li key={row} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-x-4 py-1">
                        <SkeletonLine className="w-40" />
                        <SkeletonLine className="w-16" />
                    </div>
                    <SkeletonLine className="h-1.5 w-full rounded-full" />
                    <SkeletonLine className="mt-1.5 w-32" />
                </li>
            ))}
        </ul>
    );
}

/**
 * How much of the connected Claude plan is used. The figures are Anthropic's,
 * read through Claude Code with the person's own sign-in; reading them sends
 * no prompt and uses none of the plan.
 */
export function ClaudeSubscriptionUsage() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [state, setState] = useState<"loading" | "ready" | "failed">(
        "loading",
    );

    // Bumped by Refresh: each value is one read of the figures.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let current = true;
        getClaudeSubscriptionUsage()
            .then((next) => {
                if (!current) return;
                setUsage(next);
                setState("ready");
            })
            // The card above still says whether the plan is connected; the
            // figures are an extra, so their failure stays in this block.
            .catch(() => {
                if (current) setState("failed");
            });
        return () => {
            current = false;
        };
    }, [attempt]);

    const refresh = () => {
        setState("loading");
        setAttempt((value) => value + 1);
    };

    return (
        <div className="max-w-xl space-y-3" aria-busy={state === "loading"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <SettingsLabel>Plan usage</SettingsLabel>
                <PillButtonUI
                    tone="white"
                    size="sm"
                    loading={state === "loading" && usage !== null}
                    disabled={state === "loading"}
                    onClick={refresh}
                >
                    Refresh
                </PillButtonUI>
            </div>
            {state === "failed" ? (
                <SettingsDescription>
                    Your plan usage could not be loaded. Try Refresh in a
                    moment.
                </SettingsDescription>
            ) : usage === null ? (
                <UsageSkeleton />
            ) : usage.windows.length === 0 ? (
                <SettingsDescription>
                    Anthropic reports no usage limits for this account.
                </SettingsDescription>
            ) : (
                <ul className="space-y-3">
                    {usage.windows.map((window) => (
                        <UsageRow
                            key={`${window.kind}:${window.model ?? ""}`}
                            window={window}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
