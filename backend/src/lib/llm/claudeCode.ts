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

import {
  claudeCodeEnv,
  claudeCodeExecutable,
  claudeCodeMaxConcurrency,
} from "../claudeCode/config";
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
};

type SdkModel = Exclude<LanguageModel, string>;

const waiters: Array<{ start: () => void; signal?: AbortSignal; onAbort: () => void }> = [];
let running = 0;

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
async function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  if (insideToolCall.getStore()) return () => {};
  await waitForSlot(signal);
  return releaseSlot;
}

function waitForSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (running < claudeCodeMaxConcurrency()) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      signal,
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
    waiters.push(waiter);
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

function slotLimit(kinds: ErrorKinds): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const giveBack = await acquireSlot(params.abortSignal);
      try {
        return await doGenerate();
      } catch (error) {
        throw subscriptionError(error, kinds);
      } finally {
        giveBack();
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const giveBack = await acquireSlot(params.abortSignal);
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
  const server = request.tools ? await toolServer(request.tools) : null;
  const model = provider(target.modelId, {
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
  return wrapLanguageModel({
    model,
    middleware: slotLimit(claudeCode),
  }) as SdkModel;
}
