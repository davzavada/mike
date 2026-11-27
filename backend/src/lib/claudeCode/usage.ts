// How much of a person's Claude plan is used, as Claude Code reports it.
//
// Claude Code asks Anthropic with the person's own sign-in; Mike starts it in
// the person's configuration directory, sends the usage request and nothing
// else, and passes the answer on. No prompt is sent, so reading the usage
// does not itself use any of the plan.
import {
    claudeCodeEnabled,
    claudeCodeEnv,
    claudeCodeExecutable,
    claudeCodeUserDir,
    readClaudeCodeConnection,
} from "./config";

const USAGE_TIMEOUT_MS = 20_000;
// Each read starts a Claude Code process; the settings card may ask often.
const CACHE_MS = 60_000;

export type ClaudeSubscriptionUsageWindow = {
    /** The rolling five-hour window, the week, or one model's week. */
    kind: "session" | "week" | "week_model";
    /** The model a `week_model` window counts, as Anthropic names it. */
    model: string | null;
    /** 0–100. */
    usedPercent: number;
    /** ISO 8601, or null when Anthropic gives no reset time. */
    resetsAt: string | null;
};

export type ClaudeSubscriptionUsage = {
    /** When Mike asked; the figures are at most a minute older than shown. */
    checkedAt: string;
    windows: ClaudeSubscriptionUsageWindow[];
};

export type ClaudeSubscriptionUsageResult =
    | { ok: true; usage: ClaudeSubscriptionUsage }
    | { ok: false; kind: "unavailable" | "not_connected" | "error" };

type RawWindow = {
    utilization?: number | null;
    resets_at?: string | null;
} | null;

type RawUsage = {
    rate_limits_available?: boolean;
    rate_limits?: {
        five_hour?: RawWindow;
        seven_day?: RawWindow;
        seven_day_opus?: RawWindow;
        seven_day_sonnet?: RawWindow;
        model_scoped?: Array<{
            display_name?: string;
            utilization?: number | null;
            resets_at?: string | null;
        }>;
    } | null;
};

function window(
    kind: ClaudeSubscriptionUsageWindow["kind"],
    model: string | null,
    raw: RawWindow | undefined,
): ClaudeSubscriptionUsageWindow[] {
    if (!raw || typeof raw.utilization !== "number") return [];
    return [
        {
            kind,
            model,
            usedPercent: Math.min(100, Math.max(0, raw.utilization)),
            resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : null,
        },
    ];
}

/** The windows Anthropic reports, in the order the settings card shows them. */
export function usageWindows(raw: RawUsage): ClaudeSubscriptionUsageWindow[] {
    const limits = raw.rate_limits;
    if (!raw.rate_limits_available || !limits) return [];
    const scoped = (limits.model_scoped ?? []).flatMap((entry) =>
        typeof entry.display_name === "string" && entry.display_name.trim()
            ? window("week_model", entry.display_name.trim(), entry)
            : [],
    );
    const named = new Set(scoped.map((entry) => entry.model?.toLowerCase()));
    // Older answers name Opus and Sonnet in fields of their own.
    const legacy = (
        [
            ["Opus", limits.seven_day_opus],
            ["Sonnet", limits.seven_day_sonnet],
        ] as const
    ).flatMap(([model, value]) =>
        named.has(model.toLowerCase()) ? [] : window("week_model", model, value),
    );
    return [
        ...window("session", null, limits.five_hour),
        ...window("week", null, limits.seven_day),
        ...scoped,
        ...legacy,
    ];
}

async function askClaudeCode(configDir: string): Promise<RawUsage> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let endInput!: () => void;
    const inputEnded = new Promise<void>((resolve) => {
        endInput = resolve;
    });
    // A prompt stream that never yields: the process starts, answers control
    // requests and waits, without a model request being made.
    async function* noPrompt(): AsyncGenerator<never> {
        await inputEnded;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    timer.unref?.();
    const session = query({
        prompt: noPrompt(),
        options: {
            abortController: controller,
            pathToClaudeCodeExecutable: claudeCodeExecutable(),
            cwd: configDir,
            // Replaces the environment: the deployment's keys stay out, as
            // they do for sign-in (auth.ts).
            env: claudeCodeEnv(configDir),
            tools: [],
            settingSources: [],
            strictMcpConfig: true,
            persistSession: false,
            permissionMode: "dontAsk",
        },
    });
    try {
        // The method's name says what it is: the SDK may rename it. Its
        // answer is read defensively (usageWindows) for the same reason.
        return (await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
            // Without the scan of local transcripts: only the limits matter.
            { skipBehaviors: true },
        )) as RawUsage;
    } finally {
        clearTimeout(timer);
        endInput();
        session.close();
    }
}

const cache = new Map<
    string,
    { at: number; usage: Promise<ClaudeSubscriptionUsage> }
>();

/** For tests: forget every cached answer. */
export function clearClaudeSubscriptionUsageCache(): void {
    cache.clear();
}

/**
 * The connected person's plan usage. `windows` is empty when Anthropic
 * reports none for the account.
 */
export async function getClaudeSubscriptionUsage(
    userId: string,
    ask: (configDir: string) => Promise<RawUsage> = askClaudeCode,
): Promise<ClaudeSubscriptionUsageResult> {
    if (!claudeCodeEnabled()) return { ok: false, kind: "unavailable" };
    if (!readClaudeCodeConnection(userId)) {
        cache.delete(userId);
        return { ok: false, kind: "not_connected" };
    }
    const cached = cache.get(userId);
    const fresh = cached && Date.now() - cached.at < CACHE_MS;
    const entry = fresh
        ? cached
        : {
              at: Date.now(),
              // Requests that arrive together share one process.
              usage: ask(claudeCodeUserDir(userId)).then((raw) => ({
                  checkedAt: new Date().toISOString(),
                  windows: usageWindows(raw),
              })),
          };
    if (!fresh) cache.set(userId, entry);
    try {
        return { ok: true, usage: await entry.usage };
    } catch {
        // Not kept: the next request asks again.
        if (cache.get(userId) === entry) cache.delete(userId);
        return { ok: false, kind: "error" };
    }
}
