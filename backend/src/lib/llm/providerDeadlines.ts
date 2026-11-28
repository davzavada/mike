import type { LanguageModelMiddleware } from "ai" with {
  "resolution-mode": "import",
};
import { abortable } from "../abortable";
import { streamChunkTimeouts } from "../runtimeConfig";

/**
 * What a Claude Code process reports about itself, read from a `raw` stream
 * part: the Agent SDK's own message. Only the fields the deadline reads.
 */
type AgentMessage = {
  type?: unknown;
  subtype?: unknown;
  parent_tool_use_id?: unknown;
  retry_delay_ms?: unknown;
  event?: { type?: unknown };
};

/**
 * Bound one provider call, including headers, without timing the SDK's tools.
 *
 * `toolsRunInProvider` is for a model that runs tools inside its own stream
 * (Claude Code): the wait between a tool call and its result is the tool's
 * time, not the model's, so the chunk clock stops while a call is open. The
 * results start the model's next request inside the same stream, which gets
 * the first-chunk allowance a new request to any other provider gets.
 *
 * Such a model is a process that reports on itself between its outputs: it
 * forwards the API's keep-alive pings, says when it compacts a conversation
 * or waits to retry an overloaded API, and names each new request. Each of
 * those messages shows the process is working, and renews the deadline it is
 * under; only a process that sends nothing at all is one that stopped.
 */
export function providerDeadlines(
  onActivity?: () => void,
  options: { toolsRunInProvider?: boolean } = {},
): LanguageModelMiddleware {
  return {
    wrapStream: async ({ model, params }) => {
      const limits = streamChunkTimeouts();
      const openToolCalls = new Set<string>();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(params.abortSignal?.reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The deadline a liveness signal renews: the first-output one until
      // the model produces output, then the gap between output chunks.
      let phase: [label: string, ms: number] = [
        "First chunk",
        limits.firstChunkMs,
      ];
      // Only a tool the provider runs is awaited: no deadline is armed, and
      // a liveness signal does not start one.
      let awaitingTools = false;
      const cleanup = () => {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", forwardAbort);
      };
      const arm = (label: string, ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            controller.abort(
              new DOMException(
                `${label} timeout of ${ms}ms exceeded`,
                "TimeoutError",
              ),
            ),
          ms,
        );
        timer.unref?.();
      };
      const alive = () => {
        if (!awaitingTools) arm(...phase);
      };
      const output = () => {
        awaitingTools = false;
        phase = ["Chunk", limits.chunkMs];
        arm(...phase);
        onActivity?.();
      };
      /** The model is asked again, `waitMs` from now. */
      const nextRequest = (waitMs = 0) => {
        awaitingTools = false;
        phase = ["First chunk", limits.firstChunkMs + waitMs];
        arm(...phase);
      };
      const agentMessage = (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const message = raw as AgentMessage;
        // A request to the model has started, so every tool of the one
        // before has answered, whether or not its result reached this
        // stream. A subagent's request says nothing about the calls here.
        if (
          message.type === "stream_event" &&
          message.event?.type === "message_start" &&
          !message.parent_tool_use_id
        ) {
          openToolCalls.clear();
          nextRequest();
          return;
        }
        // The API refused a request (overloaded, rate limited) and the
        // process will send it again after the wait it names.
        if (message.type === "system" && message.subtype === "api_retry") {
          if (awaitingTools) return;
          const wait = message.retry_delay_ms;
          nextRequest(typeof wait === "number" && wait > 0 ? wait : 0);
          return;
        }
        alive();
      };
      if (params.abortSignal?.aborted) forwardAbort();
      else
        params.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      arm(...phase);
      try {
        controller.signal.throwIfAborted();
        const pending = Promise.resolve(
          model.doStream({ ...params, abortSignal: controller.signal }),
        );
        // A non-cooperative provider may resolve after the deadline has fired.
        void pending.then(
          (result) => {
            if (controller.signal.aborted)
              void result.stream.cancel().catch(() => {});
          },
          () => {},
        );
        const result = await abortable(pending, controller.signal);
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream({
            async pull(sink) {
              try {
                const next = await abortable(reader.read(), controller.signal);
                if (next.done) {
                  cleanup();
                  sink.close();
                  return;
                }
                const part = next.value;
                switch (part.type) {
                  case "tool-call":
                    if (options.toolsRunInProvider) {
                      openToolCalls.add(part.toolCallId);
                      awaitingTools = true;
                      clearTimeout(timer);
                      onActivity?.();
                      break;
                    }
                    output();
                    break;
                  case "tool-result":
                    if (openToolCalls.delete(part.toolCallId)) {
                      // Once every open call is back the model is asked
                      // again: a new request, with its own time to first
                      // output.
                      if (openToolCalls.size === 0) nextRequest();
                      onActivity?.();
                    }
                    break;
                  // Output while a call is open is the model writing its
                  // next call as the first one runs. The open calls stay
                  // open: the last one written stops the clock again.
                  case "text-delta":
                  case "reasoning-delta":
                  case "tool-input-delta":
                  case "file":
                    output();
                    break;
                  // Claude 5 and Opus 4.7+ hide their thinking by default:
                  // the stream holds a thinking block start, then only pings
                  // until the signature, for as long as the model thinks.
                  // Both prove the provider is alive, so they renew this
                  // deadline. They are not output, so they leave onActivity
                  // (the run's idle deadline) to bound a model that never
                  // answers.
                  case "reasoning-start":
                  case "ping":
                    alive();
                    break;
                  case "raw":
                    if (options.toolsRunInProvider) agentMessage(part.rawValue);
                    break;
                  case "finish":
                  case "error":
                    cleanup();
                    sink.enqueue(part);
                    sink.close();
                    void reader.cancel().catch(() => {});
                    return;
                }
                sink.enqueue(part);
              } catch (error) {
                cleanup();
                void reader.cancel(error).catch(() => {});
                sink.error(error);
              }
            },
            cancel(reason) {
              cleanup();
              controller.abort(reason);
              void reader.cancel(reason).catch(() => {});
            },
          }),
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}
