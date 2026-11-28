// Claude models on a person's own Claude subscription, through Claude Code
// (docs/claude-subscription.md).
//
// Claude Code is an agent: it runs its own tool loop inside one model call,
// instead of handing tool calls back to the AI SDK step by step. Mike's tools
// are therefore offered to it as an in-process MCP server, and each call
// comes back into this process, where the usual runTools path executes it.
// Claude Code's own tools (shell, file access, web) are all switched off: the
// process runs on the server, next to other people's data.
import { AsyncLocalStorage } from "node:async_hooks";

import type { LanguageModel, LanguageModelMiddleware } from "ai" with {
  "resolution-mode": "import",
};

import { abortable } from "../abortable";
import {
  claudeCodeEnv,
  claudeCodeExecutable,
  claudeCodeMaxConcurrency,
} from "../claudeCode/config";
import { streamRunDeadlines } from "../runtimeConfig";
import { UserFacingError } from "../userFacingError";
import { ProviderConfigurationError } from "./providerErrors";
import type { OpenAIToolSchema } from "./types";

/** MCP server name; Claude Code names the tools `mcp__mike__<tool>`. */
export const CLAUDE_CODE_TOOL_SERVER = "mike";

/** Mike's tools as Claude Code calls them: one call in, its text result out. */
export type ClaudeCodeTools = {
  schemas: OpenAIToolSchema[];
  /** Rejects only to end the turn (a pause or a failed batch). */
  run: (call: {
    name: string;
    input: Record<string, unknown>;
  }) => Promise<{ text: string; isError?: boolean }>;
};

export type ClaudeCodeRequest = {
  /** Replaces Claude Code's own system prompt. */
  systemPrompt?: string;
  /** Tool-call rounds allowed before Claude Code stops. */
  maxTurns?: number;
  tools?: ClaudeCodeTools;
  /**
   * Bounds each Claude Code process from the moment it starts. Applied
   * inside the wait for a slot, which is not the model's silence.
   */
  deadlines?: LanguageModelMiddleware;
  /** Called while a streamed turn waits for a slot: it is queued, not hung. */
  onWaiting?: () => void;
};

type SdkModel = Exclude<LanguageModel, string>;

type Waiter = {
  start: () => void;
  onAbort: () => void;
  /** Someone is watching this answer arrive (a streamed chat turn). */
  interactive: boolean;
};

const waiters: Waiter[] = [];
let running = 0;

/** How often a turn that waits for a slot reports that it still does. */
const SLOT_WAIT_REPORT_MS = 30_000;

// Set while one of Mike's tools runs on behalf of a Claude Code process. A
// request made from inside it (a delegated subagent) belongs to a turn that
// already holds a slot; making it wait for another could leave every slot
// held by a parent waiting on its own child.
const insideToolCall = new AsyncLocalStorage<true>();

/**
 * One slot per Claude Code process. Each is a full CLI with its own memory,
 * so a burst of requests queues here instead of exhausting the host. Returns
 * the function that gives the slot back.
 */
async function acquireSlot(
  signal: AbortSignal | undefined,
  interactive: boolean,
  onWaiting?: () => void,
): Promise<() => void> {
  if (insideToolCall.getStore()) return () => {};
  // Every slot is held by a call with deadlines of its own, so one will come
  // back. Saying so keeps a queued turn from being ended as an idle one.
  const waiting = onWaiting
    ? setInterval(onWaiting, SLOT_WAIT_REPORT_MS)
    : undefined;
  waiting?.unref?.();
  try {
    await waitForSlot(signal, interactive);
  } finally {
    clearInterval(waiting);
  }
  return releaseSlot;
}

function waitForSlot(
  signal: AbortSignal | undefined,
  interactive: boolean,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (running < claudeCodeMaxConcurrency()) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      interactive,
      start: () => {
        signal?.removeEventListener("abort", waiter.onAbort);
        resolve();
      },
      onAbort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal?.reason);
      },
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    // One-shot work (table cells, titles) arrives in bursts and nobody
    // watches it arrive. A chat turn is watched, and its wait here counts
    // against its first-output deadline, so it goes ahead of that work.
    const firstOneShot = interactive
      ? waiters.findIndex((queued) => !queued.interactive)
      : -1;
    if (firstOneShot >= 0) waiters.splice(firstOneShot, 0, waiter);
    else waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  // The slot passes straight to the next waiter, so `running` is unchanged.
  if (next) next.start();
  else running -= 1;
}

type ErrorKinds = {
  isAuthenticationError: (error: unknown) => boolean;
  isAccountStateError: (error: unknown) => boolean;
};

/**
 * Failures the person can act on, in words that say how. Everything else
 * keeps its identity for the shared provider-error handling.
 */
function subscriptionError(error: unknown, kinds: ErrorKinds): unknown {
  if (kinds.isAuthenticationError(error)) {
    return new ProviderConfigurationError(
      "Your Claude subscription is not signed in. Connect it again in Settings → API Keys.",
      { cause: error },
    );
  }
  if (kinds.isAccountStateError(error)) {
    return new UserFacingError(
      "Your Claude account cannot be used right now because of a billing or account hold. Check it at Anthropic, or add an API key in Settings → API Keys.",
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/usage limit|limit reached|rate limit/i.test(message)) {
    return new UserFacingError(
      `Your Claude plan's usage limit was reached. ${message}`.trim(),
      { cause: error },
    );
  }
  return error;
}

function slotLimit(
  kinds: ErrorKinds,
  onWaiting?: () => void,
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ model, params }) => {
      const giveBack = await acquireSlot(params.abortSignal, false);
      // A streamed turn is bounded by providerDeadlines; a one-shot call has
      // no stream to time, and unlike an HTTP request no transport timeout
      // either. Without a limit, a process that hangs keeps its slot for
      // good, and once every slot is held no Claude request is answered
      // again. The clock starts with the process, not with the wait above.
      const limitMs = streamRunDeadlines().idleMs;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(params.abortSignal?.reason);
      if (params.abortSignal?.aborted) forwardAbort();
      else
        params.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      // The answer arrives in one piece, so this is its first-chunk deadline:
      // the wording is what marks a provider that stopped responding.
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              `First chunk timeout of ${limitMs}ms exceeded`,
              "TimeoutError",
            ),
          ),
        limitMs,
      );
      timer.unref?.();
      try {
        controller.signal.throwIfAborted();
        // abortable: the slot comes back even if the process outlives its
        // abort signal.
        return await abortable(
          Promise.resolve(
            model.doGenerate({ ...params, abortSignal: controller.signal }),
          ),
          controller.signal,
        );
      } catch (error) {
        throw subscriptionError(error, kinds);
      } finally {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", forwardAbort);
        giveBack();
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const giveBack = await acquireSlot(params.abortSignal, true, onWaiting);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        giveBack();
      };
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        // The process lives as long as its stream: hold the slot until the
        // stream ends, fails or is cancelled.
        const stream = new ReadableStream<
          Awaited<ReturnType<typeof reader.read>>["value"]
        >({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                release();
                controller.close();
              } else if (value.type === "error") {
                controller.enqueue({
                  ...value,
                  error: subscriptionError(value.error, kinds),
                });
              } else {
                controller.enqueue(value);
              }
            } catch (error) {
              release();
              controller.error(subscriptionError(error, kinds));
            }
          },
          async cancel(reason) {
            release();
            await reader.cancel(reason);
          },
        });
        return { ...result, stream } as typeof result;
      } catch (error) {
        release();
        throw subscriptionError(error, kinds);
      }
    },
  };
}

/** Claude Code's effort level for each reasoning level Mike asks for. */
const EFFORT_BY_REASONING: Record<
  string,
  "low" | "medium" | "high" | "xhigh" | "max"
> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Ask for the summary of the model's thinking. Claude 5 models return none
 * unless asked, and Claude Code does not ask on its own: the stream then
 * carries nothing for as long as the model thinks, and providerDeadlines ends
 * a long thought as a provider that stopped responding. The direct Anthropic
 * adapter asks for the same summary.
 *
 * Naming the thinking mode makes the provider ignore the request's reasoning
 * level, so the matching effort is set here with it.
 */
function summarizedThinking(): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => {
      const reasoning: string | undefined = params.reasoning;
      // "none" is left to the provider, which switches thinking off.
      if (reasoning === "none") return params;
      const effort = reasoning ? EFFORT_BY_REASONING[reasoning] : undefined;
      return {
        ...params,
        providerOptions: {
          ...params.providerOptions,
          "claude-code": {
            ...params.providerOptions?.["claude-code"],
            thinking: { type: "adaptive", display: "summarized" },
            ...(effort ? { effort } : {}),
          },
        },
      };
    },
  };
}

/** The Agent SDK's result for a run that used up its `maxTurns`. */
function isTurnLimitResult(raw: unknown): raw is {
  usage?: Record<string, unknown>;
} {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as { type?: unknown }).type === "result" &&
    (raw as { subtype?: unknown }).subtype === "error_max_turns"
  );
}

const TURN_LIMIT_MESSAGE = /reached maximum number of turns/i;

/** How the stream names a turn that ended at its tool-call round limit. */
export const TURN_LIMIT_FINISH_REASON = "error_max_turns";

/**
 * Claude Code reports a run that used up its tool-call rounds as an error,
 * and the provider turns that into a failed stream: the answer written so
 * far would end as a provider failure. Through the API the same limit ends
 * the turn with what it has and a notice (stopNotice), so the stream ends
 * here the same way, with a finish that names the limit.
 */
function turnLimitAsFinish(): LanguageModelMiddleware {
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  return {
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let limit: { usage?: Record<string, unknown> } | null = null;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "raw" && isTurnLimitResult(part.rawValue)) {
                limit = part.rawValue;
              }
              const message =
                part.type === "error" && part.error instanceof Error
                  ? part.error.message
                  : "";
              if (
                part.type !== "error" ||
                !(limit || TURN_LIMIT_MESSAGE.test(message))
              ) {
                controller.enqueue(part);
                return;
              }
              const usage = limit?.usage ?? {};
              const cacheRead = count(usage.cache_read_input_tokens);
              const cacheWrite = count(usage.cache_creation_input_tokens);
              const input = count(usage.input_tokens);
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "other", raw: TURN_LIMIT_FINISH_REASON },
                usage: {
                  inputTokens: {
                    total: input + cacheRead + cacheWrite,
                    noCache: input,
                    cacheRead,
                    cacheWrite,
                  },
                  outputTokens: {
                    total: count(usage.output_tokens),
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
            },
          }),
        ),
      };
    },
  };
}

async function toolServer(tools: ClaudeCodeTools) {
  // Loaded as ES modules, like the Agent SDK that will drive this server:
  // it must be handed the same build of the MCP classes it uses itself.
  const [{ McpServer }, { CallToolRequestSchema, ListToolsRequestSchema }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
  const mcp = new McpServer(
    { name: CLAUDE_CODE_TOOL_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  // The low-level handlers keep each tool's JSON Schema exactly as Mike
  // declares it; the high-level registration only accepts Zod shapes.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.schemas.map((schema) => ({
      name: schema.function.name,
      description: schema.function.description,
      inputSchema: {
        ...schema.function.parameters,
        type: "object" as const,
      },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { text, isError } = await insideToolCall.run(true, () =>
      tools.run({
        name: request.params.name,
        input: (request.params.arguments ?? {}) as Record<string, unknown>,
      }),
    );
    return {
      content: [{ type: "text" as const, text }],
      ...(isError ? { isError: true } : {}),
    };
  });
  return {
    type: "sdk" as const,
    name: CLAUDE_CODE_TOOL_SERVER,
    instance: mcp,
  };
}

/**
 * The subprocess environment. The provider starts from an allowlist of this
 * process's environment that includes every ANTHROPIC_, CLAUDE_, AWS_ and
 * GOOGLE_ variable; each of those is removed here, so the deployment's keys
 * can never take the place of the person's subscription.
 */
function subprocessEnv(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_)/.test(name)) {
      env[name] = undefined;
    }
  }
  return {
    ...env,
    ...claudeCodeEnv(configDir),
    // The person's claude.ai connectors are theirs, not this application's.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    // Claude Code names each session with a model request of its own, which
    // repeats the conversation. Nothing shows that name, and the request
    // would count against the person's plan on every turn.
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    // Stream a tool call's input as the model writes it. Without this the
    // API holds the input back until it is complete, and a call that carries
    // a whole document arrives after minutes in which the stream is silent:
    // providerDeadlines ends that as a provider that stopped responding.
    CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
  };
}

/**
 * A model that answers one request through the given person's Claude Code.
 * Built per request, because the request's tools travel with it.
 */
export async function createClaudeCodeModel(
  target: { modelId: string; configDir: string },
  request: ClaudeCodeRequest = {},
): Promise<SdkModel> {
  const [claudeCode, { wrapLanguageModel }] = await Promise.all([
    import("ai-sdk-provider-claude-code"),
    import("ai"),
  ]);
  const provider = claudeCode.createClaudeCode();
  // The provider's model remembers the session of its last call and resumes
  // it on the next one, and no session is kept to resume. A second call on
  // the same model (the SDK's retry after an overloaded or rate-limited
  // attempt) would fail with "No conversation found" and hide the first
  // failure, so every call gets a model, and a tool server, of its own.
  const fresh = async () => {
    const server = request.tools ? await toolServer(request.tools) : null;
    return provider(target.modelId, {
      pathToClaudeCodeExecutable: claudeCodeExecutable(),
      // Its warnings are about model ids it does not list; errors still throw.
      logger: false,
      cwd: target.configDir,
      env: subprocessEnv(target.configDir),
      // No built-in tools, no settings or MCP servers from disk, nothing kept
      // between requests: Mike holds the conversation and sends it each turn.
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      // Anything not pre-approved below is refused without a prompt.
      permissionMode: "dontAsk",
      ...(request.systemPrompt !== undefined
        ? { systemPrompt: request.systemPrompt }
        : {}),
      maxTurns: Math.min(100, Math.max(1, request.maxTurns ?? 1)),
      ...(server
        ? {
            mcpServers: { [CLAUDE_CODE_TOOL_SERVER]: server },
            allowedTools: [`mcp__${CLAUDE_CODE_TOOL_SERVER}__*`],
          }
        : { allowedTools: [] }),
    });
  };
  const sessionPerCall: LanguageModelMiddleware = {
    wrapGenerate: async ({ params }) => (await fresh()).doGenerate(params),
    wrapStream: async ({ params }) => (await fresh()).doStream(params),
  };
  return wrapLanguageModel({
    // Stands for the model's identity only; sessionPerCall answers the calls.
    model: await fresh(),
    // Outermost first: a call waits for its slot before its deadlines start.
    middleware: [
      summarizedThinking(),
      slotLimit(claudeCode, request.onWaiting),
      ...(request.deadlines ? [request.deadlines] : []),
      turnLimitAsFinish(),
      sessionPerCall,
    ],
  }) as SdkModel;
}
