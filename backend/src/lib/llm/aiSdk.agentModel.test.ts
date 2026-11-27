/**
 * streamAiSdk with an adapter whose model runs the tool loop itself (Claude
 * Code): the tools and system prompt go to the model, and each call it makes
 * comes back through the usual runTools path. A stub stands in for the agent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamAiSdk } from "./aiSdk";
import type { ClaudeCodeRequest } from "./claudeCode";
import type { NormalizedToolCall } from "./types";
import {
  AssistantStreamAskInputsPause,
  config,
  makeModel,
  okRunTools,
  textStep,
  TOOLS,
} from "./__tests__/mockLanguageModel";

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  tools: TOOLS,
  maxIterations: 5,
};

/** An agent that makes the given tool calls before answering "done". */
async function agent(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
) {
  const model = await makeModel([textStep("done")]);
  const requests: ClaudeCodeRequest[] = [];
  const results: Array<{ text: string; isError?: boolean }> = [];
  return {
    model,
    requests,
    results,
    config: {
      ...config(model),
      agentModel: async (request: ClaudeCodeRequest) => {
        requests.push(request);
        for (const call of calls) {
          results.push(await request.tools!.run(call));
        }
        return model as never;
      },
    },
  };
}

describe("agent model", () => {
  it("hands the model the system prompt, turn limit and tools", async () => {
    const stub = await agent([]);
    const res = await streamAiSdk(
      { ...base, runTools: okRunTools },
      stub.config,
    );
    expect(res.fullText).toBe("done");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].systemPrompt).toBe("S");
    expect(stub.requests[0].maxTurns).toBe(5);
    expect(stub.requests[0].tools?.schemas).toBe(TOOLS);
    // The SDK itself is given neither: the agent owns both.
    const call = stub.model.doStreamCalls[0];
    expect(call.tools ?? []).toHaveLength(0);
    expect(call.prompt.some((message) => message.role === "system")).toBe(
      false,
    );
  });

  it("announces each call and runs it through runTools under one id", async () => {
    const stub = await agent([
      { name: "read_document", input: { doc_id: "doc-0" } },
    ]);
    const started: NormalizedToolCall[] = [];
    const batches: NormalizedToolCall[][] = [];
    await streamAiSdk(
      {
        ...base,
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
        callbacks: { onToolCallStart: (call) => started.push(call) },
      },
      stub.config,
    );
    expect(started).toHaveLength(1);
    expect(batches).toEqual([[started[0]]]);
    expect(started[0]).toMatchObject({
      name: "read_document",
      input: { doc_id: "doc-0" },
    });
    expect(started[0].id).toMatch(/^call_/);
    expect(stub.results).toEqual([
      { text: JSON.stringify({ ok: true, text: "doc read_document" }) },
    ]);
  });

  it("reports the provider's web search as unavailable, to the model too", async () => {
    const stub = await agent([]);
    const events: unknown[] = [];
    await streamAiSdk(
      {
        ...base,
        runTools: okRunTools,
        providerWebSearch: { maxSearches: 3 },
        callbacks: { onWebSearch: (event) => events.push(event) },
      },
      stub.config,
    );
    expect(events).toEqual([{ kind: "unavailable" }]);
    expect(stub.requests[0].systemPrompt).toBe(
      "S\n\nWeb search is unavailable for this answer.",
    );
  });

  it("offers no tools when the request has none to run", async () => {
    const stub = await agent([]);
    await streamAiSdk({ ...base, tools: [] }, stub.config);
    expect(stub.requests[0].tools).toBeUndefined();
  });

  it("ends the turn with the tool's own error when runTools rejects", async () => {
    const pause = new AssistantStreamAskInputsPause();
    const stub = await agent([
      { name: "read_document", input: { doc_id: "doc-0" } },
    ]);
    await expect(
      streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw pause;
          },
        },
        stub.config,
      ),
    ).rejects.toBe(pause);
  });
});

describe("agent model deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /**
   * A stream that opens a tool call, waits, then returns it and answers,
   * `answerMs` after the result: the model's next request, in the same stream.
   */
  async function slowToolAgent(
    toolMs: number,
    withResult: boolean,
    answerMs = 0,
  ) {
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "t1",
              toolName: "mcp__mike__read_document",
              input: "{}",
              providerExecuted: true,
              dynamic: true,
            });
            if (!withResult) return;
            setTimeout(() => {
              controller.enqueue({
                type: "tool-result",
                toolCallId: "t1",
                toolName: "mcp__mike__read_document",
                result: "text",
              });
              const answer = () => {
                controller.enqueue({ type: "text-start", id: "a" });
                controller.enqueue({ type: "text-delta", id: "a", delta: "done" });
                controller.enqueue({ type: "text-end", id: "a" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                });
                controller.close();
              };
              if (answerMs) setTimeout(answer, answerMs);
              else answer();
            }, toolMs);
          },
        }),
      }),
    });
    return { ...config(model as never), agentModel: async () => model as never };
  }

  it("a tool inside the agent may take longer than the chunk timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    const pending = streamAiSdk(base, await slowToolAgent(30_000, true));
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toMatchObject({ fullText: "done" });
  });

  it("the model's request after a tool result gets the first-chunk allowance", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "20000");
    // 15 s to start answering: longer than a gap inside an answer may be,
    // within what a new request to any provider is allowed.
    let outcome: unknown;
    const pending = streamAiSdk(
      base,
      await slowToolAgent(30_000, true, 15_000),
    ).then(
      (result) => (outcome = result),
      (error) => (outcome = error),
    );
    for (let second = 0; second < 60 && outcome === undefined; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await pending;
    expect(outcome).toMatchObject({ fullText: "done" });
  });

  it("a model that goes silent after its tools return still times out", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "20000");
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "t1",
              toolName: "mcp__mike__read_document",
              input: "{}",
              providerExecuted: true,
              dynamic: true,
            });
            controller.enqueue({
              type: "tool-result",
              toolCallId: "t1",
              toolName: "mcp__mike__read_document",
              result: "text",
            });
          },
        }),
      }),
    });
    const pending = streamAiSdk(base, {
      ...config(model as never),
      agentModel: async () => model as never,
    });
    const assertion = expect(pending).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });

  /**
   * An agent that writes a little, runs a 30 s tool with a ping one second
   * in, then thinks silently for 32 s after the result, pinging every 8 s,
   * before it answers.
   */
  async function pingingAgent() {
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "p" });
            controller.enqueue({ type: "text-delta", id: "p", delta: "Reading. " });
            controller.enqueue({ type: "text-end", id: "p" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "t1",
              toolName: "mcp__mike__read_document",
              input: "{}",
              providerExecuted: true,
              dynamic: true,
            });
            setTimeout(() => controller.enqueue({ type: "ping" }), 1_000);
            setTimeout(() => {
              controller.enqueue({
                type: "tool-result",
                toolCallId: "t1",
                toolName: "mcp__mike__read_document",
                result: "text",
              });
              controller.enqueue({ type: "reasoning-start", id: "r" });
              for (let i = 1; i <= 4; i++) {
                setTimeout(() => controller.enqueue({ type: "ping" }), i * 8_000);
              }
              setTimeout(() => {
                controller.enqueue({ type: "text-start", id: "a" });
                controller.enqueue({ type: "text-delta", id: "a", delta: "done" });
                controller.enqueue({ type: "text-end", id: "a" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                });
                controller.close();
              }, 32_000 + 1_000);
            }, 30_000);
          },
        }),
      }),
    });
    return { ...config(model as never), agentModel: async () => model as never };
  }

  it("a ping during a tool starts no deadline, and after it renews the first-chunk one", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    let outcome: unknown;
    const pending = streamAiSdk(base, await pingingAgent()).then(
      (result) => (outcome = result),
      (error) => (outcome = error),
    );
    for (let second = 0; second < 90 && outcome === undefined; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await pending;
    expect(outcome).toMatchObject({ fullText: "Reading. done" });
  });
});
