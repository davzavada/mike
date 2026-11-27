/**
 * Which credential answers a Claude request when the person has connected a
 * Claude subscription: a saved key first, then the subscription, then the
 * deployment's key. No network and no Claude Code process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClaudeCodeModel } = vi.hoisted(() => ({
  createClaudeCodeModel: vi.fn(),
}));

vi.mock("./claudeCode", () => ({ createClaudeCodeModel }));

import { completeWithProvider } from "./providers";

const SUBSCRIPTION = { configDir: "/data/claude/user-dir" };

function anthropicMessageResponse() {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "from the API" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  });
}

async function subscriptionModel() {
  const { MockLanguageModelV3 } = await import("ai/test");
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "from the subscription" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe("Claude subscription precedence", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_API_KEY", "");
    fetchMock = vi.fn().mockResolvedValue(anthropicMessageResponse());
    vi.stubGlobal("fetch", fetchMock);
    createClaudeCodeModel.mockReset();
    createClaudeCodeModel.mockResolvedValue(await subscriptionModel());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("runs on the subscription when no key is saved", async () => {
    await expect(
      completeWithProvider({
        model: "claude-opus-5-5",
        user: "hello",
        apiKeys: { claudeCode: SUBSCRIPTION },
      }),
    ).resolves.toBe("from the subscription");
    expect(createClaudeCodeModel).toHaveBeenCalledWith({
      modelId: "claude-opus-5-5",
      configDir: SUBSCRIPTION.configDir,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["user", "org"] as const)(
    "a key saved by the %s takes precedence",
    async (origin) => {
      await expect(
        completeWithProvider({
          model: "claude-opus-5-5",
          user: "hello",
          apiKeys: {
            claude: "sk-ant-saved",
            keySources: { claude: origin },
            claudeCode: SUBSCRIPTION,
          },
        }),
      ).resolves.toBe("from the API");
      expect(createClaudeCodeModel).not.toHaveBeenCalled();
    },
  );

  it("is preferred to the deployment's key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-deployment");
    await expect(
      completeWithProvider({
        model: "claude-opus-5-5",
        user: "hello",
        apiKeys: {
          claude: "sk-ant-deployment",
          keySources: { claude: "env" },
          claudeCode: SUBSCRIPTION,
        },
      }),
    ).resolves.toBe("from the subscription");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never answers for a person who has not connected one", async () => {
    await expect(
      completeWithProvider({
        model: "claude-opus-5-5",
        user: "hello",
        apiKeys: {},
      }),
    ).rejects.toThrow(/API key is not configured/);
    expect(createClaudeCodeModel).not.toHaveBeenCalled();
  });

  it("stays off when the person switched the provider off", async () => {
    await expect(
      completeWithProvider({
        model: "claude-opus-5-5",
        user: "hello",
        apiKeys: { disabledProviders: ["claude"], claudeCode: SUBSCRIPTION },
      }),
    ).rejects.toThrow(/turned off/);
    expect(createClaudeCodeModel).not.toHaveBeenCalled();
  });
});
