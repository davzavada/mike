import type { LanguageModelMiddleware } from "ai" with {
  "resolution-mode": "import",
};
import { abortable } from "../abortable";
import { streamChunkTimeouts } from "../runtimeConfig";

/**
 * Bound one provider call, including headers, without timing the SDK's tools.
 *
 * `toolsRunInProvider` is for a model that runs tools inside its own stream
 * (Claude Code): the wait between a tool call and its result is the tool's
 * time, not the model's, so the chunk clock stops while a call is open. The
 * results start the model's next request inside the same stream, which gets
 * the first-chunk allowance a new request to any other provider gets.
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
      if (params.abortSignal?.aborted) forwardAbort();
      else
        params.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      arm("First chunk", limits.firstChunkMs);
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
                      clearTimeout(timer);
                      onActivity?.();
                      break;
                    }
                    arm("Chunk", limits.chunkMs);
                    onActivity?.();
                    break;
                  case "tool-result":
                    if (openToolCalls.delete(part.toolCallId)) {
                      // Once every open call is back the model is asked
                      // again: a new request, with its own time to first
                      // output.
                      if (openToolCalls.size === 0)
                        arm("First chunk", limits.firstChunkMs);
                      onActivity?.();
                    }
                    break;
                  case "text-delta":
                  case "reasoning-delta":
                  case "tool-input-delta":
                  case "file":
                    openToolCalls.clear();
                    arm("Chunk", limits.chunkMs);
                    onActivity?.();
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
