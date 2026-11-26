// Connecting and disconnecting a user's Claude subscription.
//
// Sign-in is Claude Code's own: Mike starts `claude auth login` in the user's
// configuration directory, hands the browser the link it prints, and passes
// the confirmation code the user gets from Anthropic back to that process.
// The process exchanges the code and stores its credentials itself. Mike
// keeps neither the code nor the credentials.
import { execFile, spawn, type ChildProcess } from "node:child_process";

import {
    claudeCodeEnabled,
    claudeCodeEnv,
    claudeCodeExecutable,
    clearClaudeCodeConnection,
    ensureClaudeCodeUserDir,
    readClaudeCodeConnection,
    writeClaudeCodeConnection,
    type ClaudeCodeConnection,
} from "./config";

const LOGIN_URL_TIMEOUT_MS = 20_000;
const LOGIN_SESSION_TTL_MS = 10 * 60_000;
const LOGIN_EXIT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const LOGIN_URL_RE = /https:\/\/[^\s"'<>]+/;
// The code Anthropic shows after sign-in: one line of URL-safe characters.
const LOGIN_CODE_RE = /^[A-Za-z0-9_\-#.~=+/]{8,2048}$/;

export type ClaudeSubscriptionStatus = {
    /** False when the deployment has not enabled Claude subscriptions. */
    available: boolean;
    connected: boolean;
    account: string | null;
    plan: string | null;
    /** The sign-in link of a login that is waiting for its code. */
    loginUrl: string | null;
};

export type ClaudeSubscriptionFailure = {
    ok: false;
    kind: "unavailable" | "validation" | "conflict" | "error";
    detail: string;
};
export type ClaudeSubscriptionResult =
    | { ok: true; status: ClaudeSubscriptionStatus }
    | ClaudeSubscriptionFailure;

type LoginSession = {
    child: ChildProcess;
    url: string;
    exited: Promise<void>;
    expiry: NodeJS.Timeout;
};

const logins = new Map<string, LoginSession>();

const UNAVAILABLE: ClaudeSubscriptionFailure = {
    ok: false,
    kind: "unavailable",
    detail: "Claude subscriptions are not enabled on this deployment.",
};

function endLogin(userId: string): void {
    const session = logins.get(userId);
    if (!session) return;
    logins.delete(userId);
    clearTimeout(session.expiry);
    if (session.child.exitCode === null) session.child.kill();
}

function statusOf(
    userId: string,
    connection: ClaudeCodeConnection | null,
): ClaudeSubscriptionStatus {
    return {
        available: true,
        connected: connection !== null,
        account: connection?.account ?? null,
        plan: connection?.plan ?? null,
        loginUrl: logins.get(userId)?.url ?? null,
    };
}

function runClaude(
    configDir: string,
    args: string[],
): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
        execFile(
            claudeCodeExecutable(),
            args,
            {
                env: claudeCodeEnv(configDir),
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => {
                const code =
                    error && typeof (error as { code?: unknown }).code === "number"
                        ? ((error as { code: number }).code)
                        : error
                          ? null
                          : 0;
                resolve({ code, stdout: String(stdout) });
            },
        );
    });
}

/**
 * Ask Claude Code who is signed in, and bring Mike's marker in line with the
 * answer. `null` means it could not be asked; the marker is left alone then.
 */
async function syncConnection(
    userId: string,
): Promise<ClaudeCodeConnection | null | undefined> {
    const dir = ensureClaudeCodeUserDir(userId);
    const { stdout } = await runClaude(dir, ["auth", "status", "--json"]);
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    // Only a subscription sign-in counts: a Console (API billing) login in
    // this directory is not what this feature offers.
    if (parsed.loggedIn !== true || parsed.authMethod !== "claude.ai") {
        clearClaudeCodeConnection(userId);
        return null;
    }
    const connection: ClaudeCodeConnection = {
        account: typeof parsed.email === "string" ? parsed.email : null,
        plan:
            typeof parsed.subscriptionType === "string"
                ? parsed.subscriptionType
                : null,
    };
    writeClaudeCodeConnection(userId, connection);
    return connection;
}

/** The settings card's view; `refresh` re-checks with Claude Code itself. */
export async function getClaudeSubscriptionStatus(
    userId: string,
    options: { refresh?: boolean } = {},
): Promise<ClaudeSubscriptionStatus> {
    if (!claudeCodeEnabled()) {
        return {
            available: false,
            connected: false,
            account: null,
            plan: null,
            loginUrl: null,
        };
    }
    if (options.refresh) {
        const synced = await syncConnection(userId);
        if (synced !== undefined) return statusOf(userId, synced);
    }
    return statusOf(userId, readClaudeCodeConnection(userId));
}

/** Start a sign-in and return the link the user opens in their browser. */
export async function startClaudeSubscriptionLogin(
    userId: string,
): Promise<ClaudeSubscriptionResult> {
    if (!claudeCodeEnabled()) return UNAVAILABLE;
    endLogin(userId);
    const dir = ensureClaudeCodeUserDir(userId);

    let child: ChildProcess;
    try {
        child = spawn(claudeCodeExecutable(), ["auth", "login", "--claudeai"], {
            // BROWSER stops Claude Code from trying to open one on the server.
            env: { ...claudeCodeEnv(dir), BROWSER: "/bin/true" },
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch {
        return {
            ok: false,
            kind: "error",
            detail: "Claude Code could not be started.",
        };
    }

    const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
    });
    const url = await new Promise<string | null>((resolve) => {
        let output = "";
        const finish = (value: string | null) => {
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            child.stderr?.off("data", onData);
            resolve(value);
        };
        const onData = (chunk: Buffer) => {
            output += chunk.toString("utf8");
            const match = LOGIN_URL_RE.exec(output);
            // Wait for the whole line: the link is long and arrives in parts.
            if (match && /\s/.test(output.slice(match.index + match[0].length)))
                finish(match[0]);
        };
        const timer = setTimeout(() => finish(null), LOGIN_URL_TIMEOUT_MS);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        void exited.then(() => finish(null));
    });
    // Keep draining so the process never blocks on a full pipe.
    child.stdout?.resume();
    child.stderr?.resume();

    if (!url) {
        if (child.exitCode === null) child.kill();
        return {
            ok: false,
            kind: "error",
            detail: "Claude Code did not offer a sign-in link.",
        };
    }

    const expiry = setTimeout(() => endLogin(userId), LOGIN_SESSION_TTL_MS);
    expiry.unref();
    logins.set(userId, { child, url, exited, expiry });
    return {
        ok: true,
        status: statusOf(userId, readClaudeCodeConnection(userId)),
    };
}

/** Hand the confirmation code to the waiting sign-in and report the result. */
export async function completeClaudeSubscriptionLogin(
    userId: string,
    code: unknown,
): Promise<ClaudeSubscriptionResult> {
    if (!claudeCodeEnabled()) return UNAVAILABLE;
    const trimmed = typeof code === "string" ? code.trim() : "";
    if (!LOGIN_CODE_RE.test(trimmed)) {
        return {
            ok: false,
            kind: "validation",
            detail: "Paste the code shown after signing in.",
        };
    }
    const session = logins.get(userId);
    if (!session || session.child.exitCode !== null) {
        endLogin(userId);
        return {
            ok: false,
            kind: "conflict",
            detail: "The sign-in expired. Start it again.",
        };
    }

    session.child.stdin?.write(`${trimmed}\n`);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        session.exited,
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LOGIN_EXIT_TIMEOUT_MS);
        }),
    ]);
    clearTimeout(timer);
    endLogin(userId);

    const connection = await syncConnection(userId);
    if (!connection) {
        return {
            ok: false,
            kind: "validation",
            detail: "The sign-in did not complete. Start it again and paste the new code.",
        };
    }
    return { ok: true, status: statusOf(userId, connection) };
}

/** Sign Claude Code out for this user and forget the connection. */
export async function disconnectClaudeSubscription(
    userId: string,
): Promise<ClaudeSubscriptionResult> {
    if (!claudeCodeEnabled()) return UNAVAILABLE;
    endLogin(userId);
    const dir = ensureClaudeCodeUserDir(userId);
    await runClaude(dir, ["auth", "logout"]);
    const remaining = await syncConnection(userId);
    if (remaining) {
        return {
            ok: false,
            kind: "error",
            detail: "Claude Code could not be signed out.",
        };
    }
    clearClaudeCodeConnection(userId);
    return { ok: true, status: statusOf(userId, null) };
}
