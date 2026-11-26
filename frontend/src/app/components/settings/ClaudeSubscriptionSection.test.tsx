import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSubscriptionStatus } from "@/app/lib/mikeApi";
import { ClaudeSubscriptionSection } from "./ClaudeSubscriptionSection";

const api = vi.hoisted(() => ({
    get: vi.fn(),
    start: vi.fn(),
    complete: vi.fn(),
    disconnect: vi.fn(),
    reloadProfile: vi.fn(),
    notifyError: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    getClaudeSubscription: api.get,
    startClaudeSubscriptionLogin: api.start,
    completeClaudeSubscriptionLogin: api.complete,
    disconnectClaudeSubscription: api.disconnect,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ reloadProfile: api.reloadProfile }),
}));

vi.mock("@/app/lib/userFacingError", () => ({ notifyError: api.notifyError }));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
}));

const status = (
    overrides: Partial<ClaudeSubscriptionStatus> = {},
): ClaudeSubscriptionStatus => ({
    available: true,
    connected: false,
    account: null,
    plan: null,
    loginUrl: null,
    ...overrides,
});

const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true";

describe("ClaudeSubscriptionSection", () => {
    beforeEach(() => {
        for (const mock of Object.values(api)) mock.mockReset();
        api.reloadProfile.mockResolvedValue(undefined);
    });

    it("renders nothing where the deployment has not enabled it", async () => {
        api.get.mockResolvedValue(status({ available: false }));
        const { container } = render(<ClaudeSubscriptionSection />);
        await waitFor(() => expect(api.get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when the server has no such route", async () => {
        api.get.mockRejectedValue(new Error("404"));
        const { container } = render(<ClaudeSubscriptionSection />);
        await waitFor(() => expect(api.get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
        expect(api.notifyError).not.toHaveBeenCalled();
    });

    it("connects: sign-in link, then the code, then the account", async () => {
        const user = userEvent.setup();
        api.get.mockResolvedValue(status());
        api.start.mockResolvedValue(status({ loginUrl: LOGIN_URL }));
        api.complete.mockResolvedValue(
            status({
                connected: true,
                account: "person@example.com",
                plan: "max",
            }),
        );
        render(<ClaudeSubscriptionSection />);

        expect(await screen.findByText("Not connected")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Connect" }));

        const link = await screen.findByRole("link", {
            name: "Open the Claude sign-in page",
        });
        expect(link).toHaveAttribute("href", LOGIN_URL);
        expect(link).toHaveAttribute("target", "_blank");
        const finish = screen.getByRole("button", { name: "Finish sign-in" });
        expect(finish).toBeDisabled();

        await user.type(screen.getByLabelText("Sign-in code"), "  abc123#state ");
        await user.click(finish);

        expect(
            await screen.findByText("person@example.com · max plan"),
        ).toBeInTheDocument();
        expect(api.complete).toHaveBeenCalledWith("abc123#state");
        expect(api.reloadProfile).toHaveBeenCalledTimes(1);
        expect(
            screen.queryByLabelText("Sign-in code"),
        ).not.toBeInTheDocument();
    });

    it("disconnects and refreshes which models are available", async () => {
        const user = userEvent.setup();
        api.get.mockResolvedValue(
            status({ connected: true, account: "person@example.com" }),
        );
        api.disconnect.mockResolvedValue(status());
        render(<ClaudeSubscriptionSection />);

        await user.click(
            await screen.findByRole("button", { name: "Disconnect" }),
        );
        expect(await screen.findByText("Not connected")).toBeInTheDocument();
        expect(api.reloadProfile).toHaveBeenCalledTimes(1);
    });

    it("reports a refused code and keeps the sign-in open", async () => {
        const user = userEvent.setup();
        const refusal = new Error("The sign-in did not complete.");
        api.get.mockResolvedValue(status({ loginUrl: LOGIN_URL }));
        api.complete.mockRejectedValue(refusal);
        render(<ClaudeSubscriptionSection />);

        await user.type(await screen.findByLabelText("Sign-in code"), "wrong-code");
        await user.click(screen.getByRole("button", { name: "Finish sign-in" }));

        await waitFor(() =>
            expect(api.notifyError).toHaveBeenCalledWith(
                refusal,
                expect.objectContaining({
                    action: "connect your Claude subscription",
                }),
            ),
        );
        expect(screen.getByLabelText("Sign-in code")).toBeInTheDocument();
        expect(api.reloadProfile).not.toHaveBeenCalled();
    });
});
