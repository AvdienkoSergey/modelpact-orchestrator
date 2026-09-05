/**
 * A provider with a counter around it.
 *
 * The rule this demo is mostly for — a side that has answered every turn is
 * left alone, and one the other side has spoken over is reopened on the record
 * — happens inside the orchestrator and shows on nothing. So each side is
 * handed in wrapped: every `open` is noted with the conversation it was given,
 * and the numbers on the right of the screen are those notes.
 *
 * The session is wrapped too, for two things the public surface does not carry
 * out: the meter, which `askStream` has nowhere to return, and the judge's
 * answer, which the orchestrator reads and keeps to itself.
 */

import type {
  AiProvider,
  AiSession,
  GenerateOptions,
  ModelAccess,
  SessionOptions,
  ContextUsage,
  Result,
  AiFailure,
} from "modelpact";

import type { OpenNote } from "../src/protocol.js";

export interface Watch {
  /** Hand this one to `orchestrate`, not the provider it was made from. */
  readonly provider: AiProvider;
  readonly opens: () => readonly OpenNote[];
  /** The live session's own meter. Two models have two of these and there is no third. */
  readonly usage: () => ContextUsage;
  /** The last thing this side said, whether or not the orchestrator kept it. */
  readonly said: () => string | null;
  readonly forget: () => void;
}

export const watch = (inner: AiProvider): Watch => {
  const opens: OpenNote[] = [];
  let live: AiSession | null = null;
  let said: string | null = null;

  const watchSession = (session: AiSession): AiSession =>
    new Proxy(session, {
      get: (target, key) => {
        if (key === "prompt")
          return async (
            input: string,
            options?: GenerateOptions,
          ): Promise<Result<string, AiFailure>> => {
            const answer = await target.prompt(input, options);
            if (answer.ok) said = answer.value;
            return answer;
          };
        if (key === "promptStream")
          return async (
            input: string,
            options?: GenerateOptions,
          ): Promise<Result<ReadableStream<string>, AiFailure>> => {
            const started = await target.promptStream(input, options);
            if (!started.ok) return started;
            const parts: string[] = [];
            return {
              ok: true,
              value: started.value.pipeThrough(
                new TransformStream<string, string>({
                  transform: (chunk, controller) => {
                    parts.push(chunk);
                    controller.enqueue(chunk);
                  },
                  flush: () => {
                    said = parts.join("");
                  },
                }),
              ),
            };
          };
        const held: unknown = Reflect.get(target, key);
        // `AiSession` extends `EventTarget`, whose methods want the real
        // object as `this`; called through the proxy they throw.
        return typeof held === "function" ? held.bind(target) : held;
      },
    });

  const note = (
    opened: Result<AiSession, AiFailure>,
    options: SessionOptions | undefined,
  ): Result<AiSession, AiFailure> => {
    if (!opened.ok) return opened;
    opens.push({ at: Date.now(), history: options?.history?.length ?? 0 });
    const seen = watchSession(opened.value);
    live = seen;
    return { ok: true, value: seen };
  };

  const watchAccess = (access: ModelAccess): ModelAccess => {
    if (access.kind === "unavailable") return access;
    if (access.kind === "ready")
      return {
        kind: "ready",
        open: async (options) => note(await access.open(options), options),
      };
    return {
      kind: "needs-download",
      started: access.started,
      open: async (monitor, options) =>
        note(await access.open(monitor, options), options),
    };
  };

  return {
    provider: {
      name: inner.name,
      access: async (request) => watchAccess(await inner.access(request)),
    },
    opens: () => opens,
    usage: () => live?.usage() ?? { kind: "unknown" },
    said: () => said,
    forget: () => {
      live = null;
    },
  };
};
