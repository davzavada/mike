import { afterEach, expect, it, vi } from "vitest";
import { streamWithProvider } from "./providers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const PING_GAP_MS = 4_000;
const PINGS = 8; // 32 s of hidden thinking: past both deadlines below.

/**
 * A Messages API stream for a Claude model whose thinking is hidden (Claude 5
 * and Opus 4.7+ default to `display: "omitted"`): a thinking block start,
 * pings while the model thinks, the signature, then the answer.
 */
function hiddenThinkingStream(): Response {
  const encoder = new TextEncoder();
  const event = (data: { type: string }) =>
    encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(
          event({
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          } as { type: string }),
        );
        controller.enqueue(
          event({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          } as { type: string }),
        );
        for (let i = 0; i < PINGS; i++) {
          await new Promise((resolve) => setTimeout(resolve, PING_GAP_MS));
          controller.enqueue(event({ type: "ping" }));
        }
        for (const data of [
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]) {
          controller.enqueue(event(data));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

it("keeps a Claude response alive while the model thinks with its thinking hidden", async () => {
  vi.useFakeTimers();
  vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
  vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
  let requested!: () => void;
  const sent = new Promise<void>((resolve) => {
    requested = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      requested();
      return hiddenThinkingStream();
    }),
  );
  const activity = vi.fn();
  const pending = streamWithProvider({
    model: "claude-opus-5-5",
    systemPrompt: "S",
    messages: [{ role: "user", content: "Question" }],
    // "none" on a model that always thinks sends no thinking settings, so
    // the API's default hides the thinking.
    reasoning: "none",
    apiKeys: { claude: "test-key" },
    callbacks: { onActivity: activity },
  }).then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  // Adapter construction imports the SDK; start the clock once it calls out.
  await sent;
  await vi.advanceTimersByTimeAsync(PING_GAP_MS * PINGS + 1_000);
  expect(await pending).toEqual({ value: expect.objectContaining({ fullText: "Answer" }) });
  // Pings prove the connection is alive, not that the run made progress.
  expect(activity).toHaveBeenCalledTimes(2);
});
