/**
 * streamAiSdk with an adapter whose model runs the tool loop itself (Claude
 * Code): the tools and system prompt go to the model, and each call it makes
 * comes back through the usual runTools path. A stub stands in for the agent.
 */
import { describe, expect, it } from "vitest";

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
