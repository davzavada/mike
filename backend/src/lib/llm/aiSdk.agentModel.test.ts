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

/**
 * What createClaudeCodeModel does with the request's deadlines: they bound
 * the call itself, inside whatever the agent model waits for first.
 */
async function withDeadlines(model: unknown, request: ClaudeCodeRequest) {
  const { wrapLanguageModel } = await import("ai");
  return wrapLanguageModel({
    model: model as never,
    middleware: request.deadlines ? [request.deadlines] : [],
  }) as never;
}

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

  type Send = (part: Record<string, unknown>) => void;
  const call = (id: string) => ({
    type: "tool-call",
    toolCallId: id,
    toolName: "mcp__mike__read_document",
    input: "{}",
    providerExecuted: true,
    dynamic: true,
  });
  const result = (id: string) => ({
    type: "tool-result",
    toolCallId: id,
    toolName: "mcp__mike__read_document",
    result: "text",
  });
  /** A message of the Claude Code process itself, as the provider relays it. */
  const raw = (rawValue: Record<string, unknown>) => ({ type: "raw", rawValue });
  const ping = raw({ type: "stream_event", event: { type: "ping" } });
  const answer = (send: Send, close: () => void, value = "done") => {
    send({ type: "text-start", id: "a" });
    send({ type: "text-delta", id: "a", delta: value });
    send({ type: "text-end", id: "a" });
    send({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    });
    close();
  };

  /** An agent whose one stream is written by `script`, on timers of its own. */
  async function scriptedAgent(
    script: (send: Send, close: () => void) => void,
  ) {
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            script(
              (part) => controller.enqueue(part as never),
              () => controller.close(),
            );
          },
        }),
      }),
    });
    return {
      ...config(model as never),
      agentModel: (request: ClaudeCodeRequest) => withDeadlines(model, request),
    };
  }

  /** Runs the turn to its end under fake timers, a second at a time. */
  async function outcomeOf(pending: Promise<unknown>, seconds = 120) {
    let outcome: unknown;
    const settled = pending.then(
      (value) => (outcome = value),
      (error) => (outcome = error),
    );
    for (let second = 0; second < seconds && outcome === undefined; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await settled;
    return outcome;
  }

  /**
   * A stream that opens a tool call, waits, then returns it and answers,
   * `answerMs` after the result: the model's next request, in the same stream.
   */
  const slowToolAgent = (toolMs: number, answerMs = 0) =>
    scriptedAgent((send, close) => {
      send(call("t1"));
      setTimeout(() => {
        send(result("t1"));
        if (answerMs) setTimeout(() => answer(send, close), answerMs);
        else answer(send, close);
      }, toolMs);
    });

  it("a tool inside the agent may take longer than the chunk timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    const pending = streamAiSdk(base, await slowToolAgent(30_000));
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toMatchObject({ fullText: "done" });
  });

  it("the model's request after a tool result gets the first-chunk allowance", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "20000");
    // 15 s to start answering: longer than a gap inside an answer may be,
    // within what a new request to any provider is allowed.
    const outcome = await outcomeOf(
      streamAiSdk(base, await slowToolAgent(30_000, 15_000)),
    );
    expect(outcome).toMatchObject({ fullText: "done" });
  });

  it("a model that goes silent after its tools return still times out", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "20000");
    const pending = streamAiSdk(
      base,
      await scriptedAgent((send) => {
        send(call("t1"));
        send(result("t1"));
      }),
    );
    const assertion = expect(pending).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });

  it("the API's keep-alive pings carry a model that writes nothing for minutes", async () => {
    // What Claude Code relays while the API holds back a long tool call or
    // the model thinks: nothing but a ping now and then.
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const activity = vi.fn();
    const outcome = await outcomeOf(
      streamAiSdk(
        { ...base, callbacks: { onActivity: activity } },
        await scriptedAgent((send, close) => {
          send({ type: "text-start", id: "t" });
          send({ type: "text-delta", id: "t", delta: "One moment. " });
          send({ type: "text-end", id: "t" });
          let pings = 0;
          const timer = setInterval(() => {
            send(ping);
            if ((pings += 1) < 30) return;
            clearInterval(timer);
            answer(send, close);
          }, 4_000);
        }),
      ),
    );
    expect(outcome).toMatchObject({ fullText: "One moment. done" });
    // A ping is not output: the run's own idle deadline still counts from
    // the last thing the model wrote.
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it("a process that stops sending even pings is ended", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const outcome = await outcomeOf(
      streamAiSdk(
        base,
        await scriptedAgent((send) => {
          send(ping);
          setTimeout(() => send(ping), 8_000);
        }),
      ),
    );
    expect(String(outcome)).toMatch(/stopped responding/);
  });

  it("a message from the process does not start the clock while a tool runs", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const outcome = await outcomeOf(
      streamAiSdk(
        base,
        await scriptedAgent((send, close) => {
          send(call("t1"));
          // The end of the model's own message arrives after the call.
          send(raw({ type: "stream_event", event: { type: "message_stop" } }));
          send(raw({ type: "rate_limit_event" }));
          setTimeout(() => {
            send(result("t1"));
            answer(send, close);
          }, 60_000);
        }),
      ),
    );
    expect(outcome).toMatchObject({ fullText: "done" });
  });

  it("a call still running when a later one returns stays untimed", async () => {
    // Claude Code starts a call while the model is still writing the next.
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const outcome = await outcomeOf(
      streamAiSdk(
        base,
        await scriptedAgent((send, close) => {
          send(call("t1"));
          send({ type: "tool-input-start", id: "t2", toolName: "x" });
          send({ type: "tool-input-delta", id: "t2", delta: "{}" });
          send({ type: "tool-input-end", id: "t2" });
          send(call("t2"));
          setTimeout(() => send(result("t2")), 1_000);
          setTimeout(() => {
            send(result("t1"));
            answer(send, close);
          }, 60_000);
        }),
      ),
    );
    expect(outcome).toMatchObject({ fullText: "done" });
  });

  it("waits out the delay Claude Code announces before it retries the API", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const outcome = await outcomeOf(
      streamAiSdk(
        base,
        await scriptedAgent((send, close) => {
          send(
            raw({ type: "system", subtype: "api_retry", retry_delay_ms: 30_000 }),
          );
          setTimeout(() => answer(send, close), 35_000);
        }),
      ),
    );
    expect(outcome).toMatchObject({ fullText: "done" });
  });

  it("a new request to the model ends the wait for a result that never came", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const outcome = await outcomeOf(
      streamAiSdk(
        base,
        await scriptedAgent((send) => {
          send(call("t1"));
          send(
            raw({ type: "stream_event", event: { type: "message_start" } }),
          );
        }),
      ),
    );
    expect(String(outcome)).toMatch(/stopped responding/);
  });
});

describe("agent model turn limit", () => {
  it("ends a turn that used up its rounds with the answer so far and a notice", async () => {
    const { step, text } = await import("./__tests__/mockLanguageModel");
    const { TURN_LIMIT_FINISH_REASON } = await import("./claudeCode");
    const model = await makeModel([
      step(...text("Partial answer."), {
        type: "finish",
        finishReason: { unified: "other", raw: TURN_LIMIT_FINISH_REASON },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
      }),
    ]);
    const res = await streamAiSdk(base, {
      ...config(model),
      agentModel: async () => model as never,
    });
    expect(res.fullText).toMatch(
      /^Partial answer\.\n\n_Stopped after 5 tool-call rounds without finishing/,
    );
  });
});
