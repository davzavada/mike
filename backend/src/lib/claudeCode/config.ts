// Per-user Claude subscriptions through Claude Code (docs/claude-subscription.md).
//
// Each Mike user who connects a subscription gets their own Claude Code
// configuration directory. The unmodified Claude Code binary that ships with
// @anthropic-ai/claude-agent-sdk signs in there through Anthropic's own flow
// and keeps its credentials there. Mike never reads, copies or logs them; it
// only records, in a marker file of its own, that a login succeeded.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const USER_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER_FILE = "mike-connection.json";

/** Off unless the operator opts in: the fork then behaves like upstream. */
export function claudeCodeEnabled(): boolean {
    const value = process.env.CLAUDE_CODE_SUBSCRIPTION?.trim().toLowerCase();
    return value === "on" || value === "true" || value === "1";
}

export function claudeCodeDataDir(): string {
    return (
        process.env.CLAUDE_CODE_DATA_DIR?.trim() ||
        path.join(os.homedir(), ".mike", "claude-code")
    );
}

/**
 * The directory one user's Claude Code runs in. The id becomes a path
 * segment, so anything that is not a UUID is refused rather than sanitized.
 */
export function claudeCodeUserDir(userId: string): string {
    if (!USER_ID_RE.test(userId)) {
        throw new Error("Claude Code needs a UUID user id.");
    }
    return path.join(claudeCodeDataDir(), userId.toLowerCase());
}

export function ensureClaudeCodeUserDir(userId: string): string {
    const dir = claudeCodeUserDir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/** How many Claude Code processes may answer requests at once. */
export function claudeCodeMaxConcurrency(): number {
    const parsed = Number.parseInt(
        process.env.CLAUDE_CODE_MAX_CONCURRENCY ?? "",
        10,
    );
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 16) : 3;
}

let cachedExecutable: string | null = null;

/**
 * The Claude Code binary as published by Anthropic: the platform package the
 * Agent SDK installs. CLAUDE_CODE_EXECUTABLE points at another copy of the
 * same binary when the platform package is not the one to use.
 */
export function claudeCodeExecutable(): string {
    const override = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
    if (override) return override;
    if (cachedExecutable) return cachedExecutable;
    const requireFromApp = createRequire(
        path.join(process.cwd(), "package.json"),
    );
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const binary = process.platform === "win32" ? "claude.exe" : "claude";
    for (const name of [base, `${base}-musl`]) {
        try {
            const manifest = requireFromApp.resolve(`${name}/package.json`);
            const candidate = path.join(path.dirname(manifest), binary);
            if (fs.existsSync(candidate)) {
                cachedExecutable = candidate;
                return candidate;
            }
        } catch {
            // Not installed for this platform; try the next candidate.
        }
    }
    throw new Error(
        "The Claude Code binary was not found. Install backend dependencies " +
            "with optional packages, or set CLAUDE_CODE_EXECUTABLE.",
    );
}

/**
 * The environment a Claude Code process gets. Built from scratch rather than
 * inherited: the deployment's provider keys must not reach it (an
 * ANTHROPIC_API_KEY would silently replace the user's subscription), and
 * nothing else in the backend's environment is its business.
 */
export function claudeCodeEnv(configDir: string): Record<string, string> {
    const env: Record<string, string> = {
        CLAUDE_CONFIG_DIR: configDir,
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_ERROR_REPORTING: "1",
    };
    for (const name of [
        "PATH",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ]) {
        const value = process.env[name];
        if (value) env[name] = value;
    }
    // With HOME on the config directory, nothing one user's Claude Code
    // writes under "~" lands in a home shared with another user's. macOS
    // keeps the login in the keychain, which is found through the real home.
    env.HOME =
        process.platform === "darwin"
            ? (process.env.HOME ?? configDir)
            : configDir;
    return env;
}

export type ClaudeCodeConnection = {
    /** The Claude account's email, as Claude Code reports it. */
    account: string | null;
    /** The subscription plan, as Claude Code reports it. */
    plan: string | null;
};

function markerPath(userId: string): string {
    return path.join(claudeCodeUserDir(userId), MARKER_FILE);
}

/**
 * Whether this user has connected a subscription, from Mike's own marker
 * file. Cheap enough to run on every request that resolves a user's keys;
 * the settings page re-checks with Claude Code itself.
 */
export function readClaudeCodeConnection(
    userId: string,
): ClaudeCodeConnection | null {
    if (!claudeCodeEnabled() || !USER_ID_RE.test(userId)) return null;
    try {
        const parsed = JSON.parse(
            fs.readFileSync(markerPath(userId), "utf8"),
        ) as Partial<ClaudeCodeConnection>;
        return {
            account: typeof parsed.account === "string" ? parsed.account : null,
            plan: typeof parsed.plan === "string" ? parsed.plan : null,
        };
    } catch {
        return null;
    }
}

export function writeClaudeCodeConnection(
    userId: string,
    connection: ClaudeCodeConnection,
): void {
    ensureClaudeCodeUserDir(userId);
    fs.writeFileSync(
        markerPath(userId),
        JSON.stringify({ ...connection, connectedAt: new Date().toISOString() }),
        { mode: 0o600 },
    );
}

export function clearClaudeCodeConnection(userId: string): void {
    fs.rmSync(markerPath(userId), { force: true });
}
