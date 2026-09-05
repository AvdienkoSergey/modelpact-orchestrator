/**
 * Three models made of strings, so the demo opens on a machine with neither
 * `claude` nor a daemon on it.
 *
 * What is on the screen is the routing, the record and the reopen rule, and
 * none of those need weights to be real. What a stub here does need is
 * `request.history`: one that ignored it could not show a turn seeing what the
 * other side answered, and that is the claim this package exists to make.
 */

import {
  contextUsage,
  createProvider,
  ok,
  tokens,
  type AiMessage,
  type AiProvider,
  type ContextUsage,
} from "modelpact/backend";

const ZERO = tokens(0) ?? (0 as never);

interface Style {
  readonly name: string;
  readonly contextWindow: number;
  /** Zero would make a stream indistinguishable from a single write. */
  readonly delayMs: number;
  readonly answer: (input: string, history: readonly AiMessage[]) => string;
}

/** Four characters to a token is close enough for a meter nobody is billed by. */
const charge = (
  messages: readonly AiMessage[],
  window: number,
): ContextUsage => {
  const characters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return contextUsage(tokens(Math.ceil(characters / 4)) ?? ZERO, window);
};

const deltas = (text: string, delayMs: number): ReadableStream<string> => {
  const parts = text.split(/(?<=[ \n])/);
  let index = 0;
  return new ReadableStream<string>({
    // Every pull either enqueues or closes: one that returns having done
    // neither is not called again, which is the bug this package's own
    // README ends on.
    pull: async (controller) => {
      const part = parts[index];
      if (part === undefined) {
        controller.close();
        return;
      }
      index += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(part);
    },
  });
};

const makeStub = (style: Style): AiProvider =>
  createProvider({
    name: style.name,
    modalities: ["text"],
    availability: () => ({ kind: "ready" }),
    connect: (options) => {
      let seen: readonly AiMessage[] = options.session.history ?? [];
      return Promise.resolve(
        ok({
          generateStream: (input, request) => {
            const said = style.answer(input, request.history);
            seen = [
              ...request.history,
              { role: "user", content: input },
              { role: "assistant", content: said },
            ];
            return Promise.resolve(ok(deltas(said, style.delayMs)));
          },
          usage: () => charge(seen, style.contextWindow),
          dispose: () => undefined,
        }),
      );
    },
  });

const clip = (text: string): string =>
  text.length > 48 ? `${text.slice(0, 48)}…` : text;

const lastFrom = (
  history: readonly AiMessage[],
  role: AiMessage["role"],
): string | null => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === role) return message.content;
  }
  return null;
};

/** What the demo's `predicate` sends to the cloud, and what its judge agrees with. */
const HARD = /\bwhy\b|\bprove\b|\bdesign\b|\bcompare\b|\btrade-?offs?\b/i;

/**
 * The small one. It gives up out loud on anything hard, which is what makes
 * `escalate` visible: that sentence is the one the policy reads and drops.
 */
export const stubLocal = makeStub({
  name: "stub:local",
  contextWindow: 4_096,
  delayMs: 18,
  answer: (input, history) => {
    if (HARD.test(input) || input.length > 240)
      return "I don't know — that one is past me.";
    const earlier = lastFrom(history, "assistant");
    if (earlier === null)
      return `The small model, opened on an empty record, answering "${clip(input)}" in one line.`;
    return `The small model. I was opened on ${history.length} messages, and the answer before mine was "${clip(earlier)}" — so I am reading a turn I did not take.`;
  },
});

/** The expensive one, and the only interesting thing it says is what it was handed. */
export const stubCloud = makeStub({
  name: "stub:cloud",
  contextWindow: 200_000,
  delayMs: 26,
  answer: (input, history) => {
    const earlier = lastFrom(history, "assistant");
    if (earlier === null)
      return `The big model, opened on an empty record, taking "${clip(input)}" at length and at a price.`;
    return `The big model. I was opened on ${history.length} messages — the last answer in them was "${clip(earlier)}", which the other side gave. One record, two models, and this is the second one reading the first.`;
  },
});

/**
 * A judge is handed the brief and the message in one prompt, and the brief is
 * three hundred characters of its own — so a stub that measured the whole
 * thing would vote cloud every time. This reads back out what a real judge
 * would be reading.
 */
const messageIn = (prompt: string): string =>
  /Message:\n([\s\S]*?)\n\nAnswer with JSON/.exec(prompt)?.[1] ?? prompt;

/**
 * The judge. It answers with the shape `classify` parses and nothing else:
 * a sentence wrapped around the JSON is exactly the case the orchestrator
 * falls back to local on.
 */
export const stubJudge = makeStub({
  name: "stub:judge",
  contextWindow: 2_048,
  delayMs: 0,
  answer: (prompt) => {
    const message = messageIn(prompt);
    return HARD.test(message) || message.length > 240
      ? '{"route":"cloud"}'
      : '{"route":"local"}';
  },
});
