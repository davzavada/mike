/**
 * Plan usage for the settings card: which windows are shown from Claude
 * Code's answer, and when Claude Code is asked at all. No process is started;
 * the answer is supplied.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeClaudeCodeConnection } from "./config";
import {
    clearClaudeSubscriptionUsageCache,
    getClaudeSubscriptionUsage,
    usageWindows,
} from "./usage";

const USER = "3f0e2c1a-9b7d-4e55-8a11-0c2d4e6f8a90";
const RESET = "2026-11-27T18:00:00Z";

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-usage-"));
    vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "on");
    vi.stubEnv("CLAUDE_CODE_DATA_DIR", dataDir);
    clearClaudeSubscriptionUsageCache();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("usageWindows", () => {
    it("lists the session, the week and each model's week", () => {
        expect(
            usageWindows({
                rate_limits_available: true,
                rate_limits: {
                    five_hour: { utilization: 42, resets_at: RESET },
                    seven_day: { utilization: 12.5, resets_at: null },
                    model_scoped: [
                        { display_name: "Fable", utilization: 80, resets_at: RESET },
                    ],
                    seven_day_opus: { utilization: 3, resets_at: RESET },
                },
            }),
        ).toEqual([
            { kind: "session", model: null, usedPercent: 42, resetsAt: RESET },
            { kind: "week", model: null, usedPercent: 12.5, resetsAt: null },
            { kind: "week_model", model: "Fable", usedPercent: 80, resetsAt: RESET },
            { kind: "week_model", model: "Opus", usedPercent: 3, resetsAt: RESET },
        ]);
    });

    it("shows a model once when both forms of the answer name it", () => {
        const windows = usageWindows({
            rate_limits_available: true,
            rate_limits: {
                model_scoped: [{ display_name: "Opus", utilization: 30 }],
                seven_day_opus: { utilization: 30, resets_at: RESET },
            },
        });
        expect(windows.map((entry) => entry.model)).toEqual(["Opus"]);
    });

    it("leaves out a window without a figure, and keeps figures in range", () => {
        expect(
            usageWindows({
                rate_limits_available: true,
                rate_limits: {
                    five_hour: { utilization: null, resets_at: RESET },
                    seven_day: { utilization: 104, resets_at: RESET },
                },
            }),
        ).toEqual([
            { kind: "week", model: null, usedPercent: 100, resetsAt: RESET },
        ]);
    });

    it("has nothing to show for an account without plan limits", () => {
        expect(
            usageWindows({ rate_limits_available: false, rate_limits: null }),
        ).toEqual([]);
    });
});

describe("getClaudeSubscriptionUsage", () => {
    const answer = {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: RESET } },
    };

    it("is unavailable where the deployment has not enabled subscriptions", async () => {
        vi.stubEnv("CLAUDE_CODE_SUBSCRIPTION", "");
        const ask = vi.fn();
        await expect(getClaudeSubscriptionUsage(USER, ask)).resolves.toEqual({
            ok: false,
            kind: "unavailable",
        });
        expect(ask).not.toHaveBeenCalled();
    });

    it("does not start Claude Code for a person who has not connected", async () => {
        const ask = vi.fn();
        await expect(getClaudeSubscriptionUsage(USER, ask)).resolves.toEqual({
            ok: false,
            kind: "not_connected",
        });
        expect(ask).not.toHaveBeenCalled();
    });

    it("asks in the person's own directory and reports the windows", async () => {
        writeClaudeCodeConnection(USER, { account: "a@example.com", plan: "max" });
        const ask = vi.fn().mockResolvedValue(answer);
        const result = await getClaudeSubscriptionUsage(USER, ask);
        expect(ask).toHaveBeenCalledWith(path.join(dataDir, USER));
        expect(result).toMatchObject({
            ok: true,
            usage: {
                windows: [
                    { kind: "session", model: null, usedPercent: 42, resetsAt: RESET },
                ],
            },
        });
    });

    it("asks once for requests within a minute, then again", async () => {
        vi.useFakeTimers();
        writeClaudeCodeConnection(USER, { account: null, plan: null });
        const ask = vi.fn().mockResolvedValue(answer);
        await Promise.all([
            getClaudeSubscriptionUsage(USER, ask),
            getClaudeSubscriptionUsage(USER, ask),
        ]);
        await getClaudeSubscriptionUsage(USER, ask);
        expect(ask).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_001);
        await getClaudeSubscriptionUsage(USER, ask);
        expect(ask).toHaveBeenCalledTimes(2);
    });

    it("reports a failure and asks again the next time", async () => {
        writeClaudeCodeConnection(USER, { account: null, plan: null });
        const ask = vi
            .fn()
            .mockRejectedValueOnce(new Error("process exited"))
            .mockResolvedValue(answer);
        await expect(getClaudeSubscriptionUsage(USER, ask)).resolves.toEqual({
            ok: false,
            kind: "error",
        });
        await expect(getClaudeSubscriptionUsage(USER, ask)).resolves.toMatchObject(
            { ok: true },
        );
    });
});
