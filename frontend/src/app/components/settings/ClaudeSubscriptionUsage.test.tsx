import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSubscriptionUsage as Usage } from "@/app/lib/mikeApi";
import { ClaudeSubscriptionUsage } from "./ClaudeSubscriptionUsage";

const api = vi.hoisted(() => ({ usage: vi.fn() }));

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    getClaudeSubscriptionUsage: api.usage,
}));

const usage = (windows: Usage["windows"]): Usage => ({
    checkedAt: "2026-11-27T13:00:00Z",
    windows,
});

describe("ClaudeSubscriptionUsage", () => {
    beforeEach(() => api.usage.mockReset());

    it("shows each limit with its share used and its reset time", async () => {
        api.usage.mockResolvedValue(
            usage([
                {
                    kind: "session",
                    model: null,
                    usedPercent: 41.6,
                    resetsAt: "2099-01-05T18:00:00Z",
                },
                { kind: "week", model: null, usedPercent: 12, resetsAt: null },
                {
                    kind: "week_model",
                    model: "Fable",
                    usedPercent: 80,
                    resetsAt: null,
                },
            ]),
        );
        render(<ClaudeSubscriptionUsage />);

        const session = await screen.findByRole("progressbar", {
            name: "Current session (5 hours)",
        });
        expect(session).toHaveAttribute("aria-valuenow", "42");
        expect(screen.getByText("42% used")).toBeInTheDocument();
        expect(screen.getByText(/^Resets .+ at /)).toBeInTheDocument();
        expect(
            screen.getByRole("progressbar", { name: "This week, all models" }),
        ).toHaveAttribute("aria-valuenow", "12");
        expect(
            screen.getByRole("progressbar", { name: "This week, Fable" }),
        ).toHaveAttribute("aria-valuenow", "80");
    });

    it("says so when the account has no limits to show", async () => {
        api.usage.mockResolvedValue(usage([]));
        render(<ClaudeSubscriptionUsage />);
        expect(
            await screen.findByText(
                "Anthropic reports no usage limits for this account.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("reports a failed read and loads again on Refresh", async () => {
        const user = userEvent.setup();
        api.usage.mockRejectedValueOnce(new Error("502"));
        api.usage.mockResolvedValue(
            usage([
                { kind: "week", model: null, usedPercent: 5, resetsAt: null },
            ]),
        );
        render(<ClaudeSubscriptionUsage />);

        expect(
            await screen.findByText(/could not be loaded/),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(await screen.findByText("5% used")).toBeInTheDocument();
        await waitFor(() => expect(api.usage).toHaveBeenCalledTimes(2));
    });
});
