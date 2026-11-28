/**
 * The model Mike builds around Claude Code (claudeCode.ts): what it asks the
 * provider for, and how a call that fails or hangs gives its slot back. The
 * provider package is replaced by scripted models; no Claude Code process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { finish, step, text, textStep } from "./__tests__/mockLanguageModel";
import type { ClaudeCodeRequest } from "./claudeCode";

type Call = { instance: number; params: Record<string, unknown> };
type GenerateScript = (call: Call) => Promise<unknown>;

const provider = vi.hoisted(() => ({
  instances: 0,
  generateCalls: [] as Call[],
  streamCalls: [] as Call[],
  settings: [] as Array<Record<string, unknown>>,
  generate: null as GenerateScript | null,
  stream: null as ((call: Call) => Promise<unknown>) | null,
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  isAuthenticationError: () => false,
  isAccountStateError: () => false,
  createClaudeCode: () => (_id: string, settings: Record<string, unknown>) => {
    const instance = (provider.instances += 1);
    provider.settings.push(settings);
    return {
      specificationVersion: "v3",
      provider: "claude-code",
      modelId: "claude-opus-5-5",
      supportedUrls: {},
      doGenerate: (params: Record<string, unknown>) => {
        const call = { instance, params };
        provider.generateCalls.push(call);
        return provider.generate!(call);
      },
      doStream: (params: Record<string, unknown>) => {
        const call = { instance, params };
        provider.streamCalls.push(call);
        return provider.stream!(call);
      },
    };
  },
}));

const answer = (value: string) => ({
  content: [{ type: "text", text: value }],
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
});

const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: "go" }] },
];

/** A fresh module: its slot counter starts empty for every test. */
async function claudeCodeModel(request?: ClaudeCodeRequest) {
  vi.resetModules();
  const { createClaudeCodeModel } = await import("./claudeCode.js");
  return createClaudeCodeModel(
    { modelId: "claude-opus-5-5", configDir: "/data/claude/user-dir" },
    request,
  );
}

async function parts(result: { stream: ReadableStream<unknown> }) {
  const read: Array<Record<string, unknown>> = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return read;
    read.push(next.value as Record<string, unknown>);
  }
}

async function drain(result: { stream: ReadableStream<unknown> }) {
  const reader = result.stream.getReader();
  while (!(await reader.read()).done) {
    // Read to the end: the slot is held until the stream closes.
  }
}

beforeEach(() => {
  provider.instances = 0;
  provider.generateCalls = [];
  provider.streamCalls = [];
  provider.settings = [];
  provider.generate = async () => answer("ok");
  provider.stream = async () => textStep("ok");
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/bin/claude");
  vi.stubEnv("CLAUDE_CODE_MAX_CONCURRENCY", "1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("thinking", () => {
  it("asks for the thinking summary, with the effort of the reasoning level", async () => {
    const model = await claudeCodeModel();
    await drain(
      await model.doStream({ prompt, reasoning: "high" } as never),
    );
    expect(provider.streamCalls[0].params.providerOptions).toEqual({
      "claude-code": {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });

  it("asks for the summary when the reasoning level is the provider's own", async () => {
    const model = await claudeCodeModel();
    await drain(await model.doStream({ prompt } as never));
    expect(provider.streamCalls[0].params.providerOptions).toEqual({
      "claude-code": { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it("leaves switching thinking off to the provider", async () => {
    const model = await claudeCodeModel();
    await drain(
      await model.doStream({ prompt, reasoning: "none" } as never),
    );
    expect(provider.streamCalls[0].params.reasoning).toBe("none");
    expect(provider.streamCalls[0].params.providerOptions).toBeUndefined();
  });
});

describe("process", () => {
  it("has Claude Code stream a tool call's input as the model writes it", async () => {
    // Held back until complete, a call that carries a whole document is
    // minutes of silence, which ends the turn as a model that stopped.
    await claudeCodeModel();
    const env = provider.settings[0].env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING).toBe("1");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/user-dir");
  });
});

describe("turn limit", () => {
  const limitResult = {
    type: "raw",
    rawValue: {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
        output_tokens: 7,
      },
    },
  };

  it("ends a run that used up its rounds as a finished stream that names the limit", async () => {
    const model = await claudeCodeModel();
    provider.stream = async () =>
      step(...text("So far."), limitResult as never, {
        type: "error",
        error: new Error("Reached maximum number of turns (16)"),
      });
    const read = await parts(await model.doStream({ prompt } as never));
    expect(read.some((part) => part.type === "error")).toBe(false);
    expect(read.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "other", raw: "error_max_turns" },
      usage: {
        inputTokens: { total: 33, noCache: 3, cacheRead: 10, cacheWrite: 20 },
        outputTokens: { total: 7 },
      },
    });
  });

  it("recognises the limit by its message when the result itself is not relayed", async () => {
    const model = await claudeCodeModel();
    provider.stream = async () =>
      step({
        type: "error",
        error: new Error(
          "Claude Code returned an error result: Reached maximum number of turns (16)",
        ),
      });
    const read = await parts(await model.doStream({ prompt } as never));
    expect(read.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { raw: "error_max_turns" },
    });
  });

  it("leaves every other failure a failure", async () => {
    const model = await claudeCodeModel();
    const failure = new Error("Claude Code process exited with code 1");
    provider.stream = async () => step({ type: "error", error: failure });
    const read = await parts(await model.doStream({ prompt } as never));
    expect(read.at(-1)).toEqual({ type: "error", error: failure });
  });
});

describe("sessions", () => {
  it("answers each call with a provider model of its own", async () => {
    // The provider's model resumes the session of its previous call, which
    // was never kept: a retry on the same model could only fail.
    const model = await claudeCodeModel();
    await model.doGenerate({ prompt } as never);
    await model.doGenerate({ prompt } as never);
    await drain(await model.doStream({ prompt } as never));
    const used = [
      ...provider.generateCalls.map((call) => call.instance),
      ...provider.streamCalls.map((call) => call.instance),
    ];
    expect(new Set(used).size).toBe(3);
  });
});

describe("slots", () => {
  it("ends a one-shot call that never answers, and gives its slot back", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_IDLE_TIMEOUT_MS", "30000");
    const model = await claudeCodeModel();
    provider.generate = () => new Promise(() => {});

    const hung = model.doGenerate({ prompt } as never);
    const outcome = expect(hung).rejects.toThrow(
      /First chunk timeout of 30000ms exceeded/,
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await outcome;
    // The process is told to stop, not just abandoned.
    const signal = provider.generateCalls[0].params.abortSignal as AbortSignal;
    expect(signal.aborted).toBe(true);

    // With one slot, this only answers if the hung call returned it.
    provider.generate = async () => answer("next");
    await expect(model.doGenerate({ prompt } as never)).resolves.toMatchObject(
      { content: [{ type: "text", text: "next" }] },
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a one-shot call when its caller gives up", async () => {
    const model = await claudeCodeModel();
    provider.generate = () => new Promise(() => {});
    const caller = new AbortController();

    const pending = model.doGenerate({
      prompt,
      abortSignal: caller.signal,
    } as never);
    const outcome = expect(pending).rejects.toThrow("Chat title timed out");
    await vi.waitFor(() => expect(provider.generateCalls).toHaveLength(1));
    caller.abort(new DOMException("Chat title timed out", "TimeoutError"));
    await outcome;

    provider.generate = async () => answer("next");
    await expect(
      model.doGenerate({ prompt } as never),
    ).resolves.toBeDefined();
  });

  it("starts a waiting chat turn before one-shot calls that queued earlier", async () => {
    const model = await claudeCodeModel();
    const started: string[] = [];
    let finishFirst!: () => void;
    provider.generate = ({ params }) => {
      started.push(String(params.maxOutputTokens));
      if (params.maxOutputTokens !== 1) return Promise.resolve(answer("ok"));
      return new Promise((resolve) => {
        finishFirst = () => resolve(answer("first"));
      });
    };
    provider.stream = async () => {
      started.push("chat");
      return step(...text("ok"), finish("stop"));
    };

    // One slot: the first call holds it while the others queue in this order.
    const first = model.doGenerate({ prompt, maxOutputTokens: 1 } as never);
    await vi.waitFor(() => expect(started).toEqual(["1"]));
    const cell = model.doGenerate({ prompt, maxOutputTokens: 2 } as never);
    const chat = model.doStream({ prompt } as never).then(drain);

    finishFirst();
    await Promise.all([first, cell, chat]);
    expect(started).toEqual(["1", "chat", "2"]);
  });

  it("starts a turn's deadlines when its process starts, not while it queues", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const { providerDeadlines } = await import("./providerDeadlines.js");
    const waiting = vi.fn();
    const model = await claudeCodeModel({
      deadlines: providerDeadlines(),
      onWaiting: waiting,
    });
    let finishFirst!: () => void;
    provider.generate = () =>
      new Promise((resolve) => {
        finishFirst = () => resolve(answer("first"));
      });

    // One slot, held for far longer than a model may stay silent.
    const first = model.doGenerate({ prompt } as never);
    await vi.waitFor(() => expect(provider.generateCalls).toHaveLength(1));
    const chat = model.doStream({ prompt } as never).then(parts);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(provider.streamCalls).toHaveLength(0);
    // Reported while it waits, so the run is not ended as an idle one.
    expect(waiting).toHaveBeenCalledTimes(3);

    finishFirst();
    await first;
    const read = await chat;
    expect(read.at(-1)).toMatchObject({ type: "finish" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting).toHaveBeenCalledTimes(3);
  });

  it("ends a process that stays silent once it has its slot", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const { providerDeadlines } = await import("./providerDeadlines.js");
    const model = await claudeCodeModel({ deadlines: providerDeadlines() });
    provider.stream = () => new Promise(() => {});

    const hung = model.doStream({ prompt } as never);
    const outcome = expect(hung).rejects.toThrow(
      /First chunk timeout of 10000ms exceeded/,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await outcome;
    // The slot came back: with one slot, this only answers if it did.
    provider.stream = async () => textStep("next");
    const read = await parts(await model.doStream({ prompt } as never));
    expect(read.at(-1)).toMatchObject({ type: "finish" });
  });
});
