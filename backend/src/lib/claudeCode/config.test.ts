import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    claudeCodeEnabled,
    claudeCodeEnv,
    claudeCodeMaxConcurrency,
    claudeCodeUserDir,
    clearClaudeCodeConnection,
    readClaudeCodeConnection,
    writeClaudeCodeConnection,
} from "./config";

const USER = "3f0e2c1a-9b7d-4e55-8a11-0c2d4e6f8a90";

describe("Claude Code configuration", () => {
    let dataDir: string;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-claude-"));
        vi.stubEnv("CLAUDE_CODE_DATA_DIR", dataDir);
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "on");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it.each([
        ["on", true],
        ["TRUE", true],
        ["1", true],
        ["", false],
        ["off", false],
    ])("CLAUDE_CODE_SUBSCRIPTION=%j enables it: %s", (value, enabled) => {
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", value);
        expect(claudeCodeEnabled()).toBe(enabled);
    });

    it("gives each user a directory of their own under the data directory", () => {
        expect(claudeCodeUserDir(USER.toUpperCase())).toBe(
            path.join(dataDir, USER),
        );
    });

    it.each(["", "../etc", "user-1", `${USER}/..`, `${USER}\n`])(
        "refuses the user id %j as a path segment",
        (userId) => {
            expect(() => claudeCodeUserDir(userId)).toThrow();
        },
    );

    it("records, reads back and forgets a connection", () => {
        expect(readClaudeCodeConnection(USER)).toBeNull();
        writeClaudeCodeConnection(USER, {
            account: "person@example.com",
            plan: "max",
        });
        expect(readClaudeCodeConnection(USER)).toEqual({
            account: "person@example.com",
            plan: "max",
        });
        const mode = fs.statSync(claudeCodeUserDir(USER)).mode & 0o777;
        expect(mode).toBe(0o700);
        clearClaudeCodeConnection(USER);
        expect(readClaudeCodeConnection(USER)).toBeNull();
    });

    it("reports nobody as connected while the feature is off", () => {
        writeClaudeCodeConnection(USER, { account: null, plan: null });
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "off");
        expect(readClaudeCodeConnection(USER)).toBeNull();
    });

    it("reports a user id that is not a UUID as not connected", () => {
        expect(readClaudeCodeConnection("user-1")).toBeNull();
    });

    it("keeps the deployment's provider keys out of the subprocess", () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-deployment");
        vi.stubEnv("OPENAI_API_KEY", "sk-openai");
        vi.stubEnv("SUPABASE_SECRET_KEY", "service-role");
        const env = claudeCodeEnv("/data/claude/u");
        expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/u");
        expect(Object.keys(env)).not.toEqual(
            expect.arrayContaining([
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "SUPABASE_SECRET_KEY",
            ]),
        );
        expect(JSON.stringify(env)).not.toMatch(/sk-ant|sk-openai|service-role/);
    });

    it.each([
        ["", 3],
        ["0", 3],
        ["abc", 3],
        ["5", 5],
        ["500", 16],
    ])("CLAUDE_CODE_MAX_CONCURRENCY=%j allows %i processes", (value, max) => {
        vi.stubEnv("CLAUDE_CODE_MAX_CONCURRENCY", value);
        expect(claudeCodeMaxConcurrency()).toBe(max);
    });
});
