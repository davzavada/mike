/**
 * The sign-in flow against a stand-in for the Claude Code binary: a shell
 * script that speaks the same three commands (`auth login`, `auth status`,
 * `auth logout`) and keeps its "credentials" in the config directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    completeClaudeSubscriptionLogin,
    disconnectClaudeSubscription,
    getClaudeSubscriptionStatus,
    startClaudeSubscriptionLogin,
} from "./auth";
import { claudeCodeUserDir, readClaudeCodeConnection } from "./config";

const USER = "3f0e2c1a-9b7d-4e55-8a11-0c2d4e6f8a90";
const OTHER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=abc";

const FAKE_CLAUDE = `#!/bin/sh
state="$CLAUDE_CONFIG_DIR/fake-credentials"
case "$1 $2" in
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: ${LOGIN_URL}"
    printf 'Paste code here if prompted > '
    read code
    if [ "$code" = "good-code#state" ]; then
      echo "$ANTHROPIC_API_KEY" > "$state"
      echo "Login successful."
      exit 0
    fi
    echo "Login failed" >&2
    exit 1
    ;;
  "auth status")
    if [ -f "$state" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"person@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'
      exit 1
    fi
    ;;
  "auth logout")
    rm -f "$state"
    ;;
esac
`;

describe.skipIf(process.platform === "win32")("Claude subscription sign-in", () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "mike-claude-auth-"));
        const executable = path.join(root, "claude");
        fs.writeFileSync(executable, FAKE_CLAUDE, { mode: 0o755 });
        vi.stubEnv("CLAUDE_CODE_EXECUTABLE", executable);
        vi.stubEnv("CLAUDE_CODE_DATA_DIR", path.join(root, "data"));
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "on");
        vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-deployment");
    });

    afterEach(async () => {
        await disconnectClaudeSubscription(USER);
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("is unavailable, and starts nothing, while the feature is off", async () => {
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "off");
        await expect(getClaudeSubscriptionStatus(USER)).resolves.toMatchObject({
            available: false,
            connected: false,
        });
        await expect(startClaudeSubscriptionLogin(USER)).resolves.toMatchObject({
            ok: false,
            kind: "unavailable",
        });
        expect(fs.existsSync(path.join(root, "data"))).toBe(false);
    });

    it("connects with the link and the code, then disconnects", async () => {
        const started = await startClaudeSubscriptionLogin(USER);
        expect(started).toMatchObject({
            ok: true,
            status: { connected: false, loginUrl: LOGIN_URL },
        });
        // A reload of the settings page finds the sign-in still waiting.
        await expect(
            getClaudeSubscriptionStatus(USER, { refresh: true }),
        ).resolves.toMatchObject({ connected: false, loginUrl: LOGIN_URL });

        await expect(
            completeClaudeSubscriptionLogin(USER, "  good-code#state\n"),
        ).resolves.toEqual({
            ok: true,
            status: {
                available: true,
                connected: true,
                account: "person@example.com",
                plan: "max",
                loginUrl: null,
            },
        });
        expect(readClaudeCodeConnection(USER)).toEqual({
            account: "person@example.com",
            plan: "max",
        });
        // The deployment's key never reached the sign-in process.
        expect(
            fs
                .readFileSync(
                    path.join(claudeCodeUserDir(USER), "fake-credentials"),
                    "utf8",
                )
                .trim(),
        ).toBe("");
        // One person's connection is nobody else's.
        expect(readClaudeCodeConnection(OTHER)).toBeNull();

        await expect(disconnectClaudeSubscription(USER)).resolves.toMatchObject({
            ok: true,
            status: { connected: false },
        });
        expect(readClaudeCodeConnection(USER)).toBeNull();
    });

    it("reports a code that Claude Code refuses", async () => {
        await startClaudeSubscriptionLogin(USER);
        await expect(
            completeClaudeSubscriptionLogin(USER, "wrong-code"),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        expect(readClaudeCodeConnection(USER)).toBeNull();
        // The refused sign-in is over: a new one has to be started.
        await expect(
            completeClaudeSubscriptionLogin(USER, "good-code#state"),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
    });

    it.each([undefined, "", "short", "two\nlines-of-code", "x".repeat(3000)])(
        "refuses the malformed code %j without passing it on",
        async (code) => {
            await startClaudeSubscriptionLogin(USER);
            await expect(
                completeClaudeSubscriptionLogin(USER, code),
            ).resolves.toMatchObject({ ok: false, kind: "validation" });
            // The sign-in is still waiting for a real code.
            await expect(
                completeClaudeSubscriptionLogin(USER, "good-code#state"),
            ).resolves.toMatchObject({ ok: true });
        },
    );

    it("needs a sign-in to have been started", async () => {
        await expect(
            completeClaudeSubscriptionLogin(USER, "good-code#state"),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
    });

    it("forgets a connection Claude Code no longer has", async () => {
        await startClaudeSubscriptionLogin(USER);
        await completeClaudeSubscriptionLogin(USER, "good-code#state");
        fs.rmSync(path.join(claudeCodeUserDir(USER), "fake-credentials"));

        // The marker alone still says connected, until the page re-checks.
        await expect(getClaudeSubscriptionStatus(USER)).resolves.toMatchObject({
            connected: true,
        });
        await expect(
            getClaudeSubscriptionStatus(USER, { refresh: true }),
        ).resolves.toMatchObject({ connected: false });
        expect(readClaudeCodeConnection(USER)).toBeNull();
    });
});
