/**
 * Several models in one conversation, and a policy that picks between them.
 *
 * A consumer of `modelpact`, not an extension of it. The first version of this
 * file was a `ModelBackend` composed of two others, and every guarantee a
 * session makes leaked through it: a usage meter over two different windows, an
 * overflow event that means nothing for the side that did not fire it, an inner
 * session that had to be reopened to be told about turns it had not answered.
 * None of that was a hard problem badly solved. It was one storey too low.
 *
 * Up here nothing has to be forced. A session is one model's; this holds as
 * many as the caller names and a record of its own, and `open({ history })` —
 * the door the contract already has — is how a side is handed the conversation
 * it missed.
 *
 * The sides are named by the caller and there may be any number of them. Two
 * was never a property of the idea, only of the first use: a local model and a
 * cloud one. A ladder of three — small, middle, strong — is the same router
 * with one more key, and a single side is the degenerate case that routes
 * nowhere, which is exactly what a caller with one model wants it to do.
 */

import type {
  AiFailure,
  AiMessage,
  AiProvider,
  AiSession,
  ContextUsage,
  JsonSchema,
  ModelAccess,
  Result,
} from "modelpact";

/**
 * The name the caller gave a side. Any string: these names are the caller's
 * vocabulary — "local" and "cloud", or "granite", "haiku", "sonnet" — and they
 * come back in `Answer.side` and in `onRoute`, so they are what its logs and
 * its policy already speak.
 */
export type Side = string;

/**
 * Per-turn options, passed on unchanged to whichever side answers.
 *
 * Only a schema, because it is the one option a caller above a router needs
 * per turn and the one that was lost here: an agent that asks in a shape got
 * prose from the local side for want of this parameter, and had to read the
 * object out of thirty kilobytes of second thoughts. A signal is the
 * session's; usage is a side's; neither passes through.
 */
export interface AskOptions {
  /** Honoured or refused by the side that answers, never dropped on the way. */
  readonly schema?: JsonSchema;
}

export type Policy =
  /** Decided from the input alone: length, a keyword, a marker of private data. */
  | {
      readonly kind: "predicate";
      /**
       * The name of the side to answer this turn. A name that is not a side is
       * a bug in the caller, and comes back as an `invalid-input` refusal
       * naming what it could have said — not a silent fall back to some other
       * model, which would answer at a price nobody chose.
       */
      readonly choose: (input: string, history: readonly AiMessage[]) => Side;
    }
  /**
   * Sides are tried in order and the first answer `accept` keeps is the one
   * kept. Nothing streams before the decision, because an answer that is
   * thrown away cannot be un-shown. That is the cost of the policy, not a
   * limitation of anything under it.
   *
   * The last side in the order is the backstop: its answer is kept whether
   * `accept` likes it or not, because there is nothing further to ask.
   */
  | {
      readonly kind: "escalate";
      /** Defaults to every side, in the order the caller listed them. */
      readonly order?: readonly Side[];
      readonly accept: (answer: string, side: Side) => boolean;
    }
  /** A judge — meant to be a small local model — is asked with a schema which way to send the turn. */
  | {
      readonly kind: "classify";
      readonly judge: AiProvider;
      readonly brief?: string;
    };

export interface OrchestratorParts {
  /**
   * The sides, by name. Insertion order is the caller's own ordering — cheapest
   * first is the convention the policies assume — and the first one is where a
   * turn goes when nothing else decides: an unusable judge, a policy that
   * cannot choose.
   */
  readonly sides: Readonly<Record<Side, AiProvider>>;
  readonly policy: Policy;
  /** Given to every session opened, on any side. */
  readonly system?: string;
  /** The conversation to start from, as `AiSession` takes one. */
  readonly history?: readonly AiMessage[];
  readonly onRoute?: (side: Side, reason: string) => void;
}

export interface Answer {
  readonly side: Side;
  readonly text: string;
  /** The answering side's own meter. Two models have two windows; there is no third. */
  readonly usage: ContextUsage;
}

export interface Orchestrator {
  /** The conversation every side is part of, oldest first. */
  readonly record: () => readonly AiMessage[];
  readonly ask: (
    input: string,
    options?: AskOptions,
  ) => Promise<Result<Answer, AiFailure>>;
  /**
   * The same turn, in pieces. `escalate` cannot stream: it has to read an
   * answer whole before it knows whether to keep it, so the accepted answer
   * arrives as one piece.
   */
  readonly askStream: (
    input: string,
    options?: AskOptions,
  ) => Promise<Result<ReadableStream<string>, AiFailure>>;
  readonly close: () => void;
}

/**
 * The default brief names the sides in the caller's own order, so a judge that
 * knows nothing about them still knows what it may answer and which way is
 * cheap. A caller whose names carry no such meaning passes its own `brief`.
 */
const routeBrief = (names: readonly Side[]): string =>
  `You route a user's message to one of several models, named: ${names.join(", ")}. They are listed cheapest and smallest first. Answer with the earliest one that can do the message well: the earliest names for greetings, small talk, simple factual questions, formatting and short tasks; a later one for multi-step reasoning, long writing, code that must be correct, or anything where a mistake is costly.`;

/** `JSON.parse` hands back `any`; this is the one door that makes it `unknown`. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** A name that is not a side: the caller's bug, said back with what it could have said. */
const notASide = (chosen: Side, names: readonly Side[]): AiFailure => ({
  kind: "invalid-input",
  detail: `the policy chose "${chosen}", which is not one of the sides: ${names.join(", ")}`,
});

const openSessionOn = async (
  provider: AiProvider,
  history: readonly AiMessage[],
  system: string | undefined,
): Promise<Result<AiSession, AiFailure>> => {
  const access: ModelAccess = await provider.access();
  if (access.kind === "unavailable") return err(access.reason);
  const options = {
    history,
    ...(system === undefined ? {} : { system }),
  };
  // The download, if there is one, is the caller's to have consented to; a
  // second open finds it done.
  return access.kind === "ready"
    ? access.open(options)
    : access.open(() => undefined, options);
};

const makeSingleChunkStream = (text: string): ReadableStream<string> =>
  new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue(text);
      controller.close();
    },
  });

/**
 * One side's session, opened lazily and kept while it stays current.
 *
 * A model that keeps its own transcript is warm: reopening it costs the state
 * it built. So it is reopened only when another side has spoken since, which
 * is the one case where its own idea of the conversation has gone stale. A
 * model with no memory does not care either way and is handed the record
 * every time by the same rule.
 */
class SideSession {
  readonly #provider: AiProvider;
  readonly #system: string | undefined;
  #session: AiSession | null = null;
  #seenTurns = 0;

  constructor(provider: AiProvider, system: string | undefined) {
    this.#provider = provider;
    this.#system = system;
  }

  /** Current when it has answered every turn in the record since it was opened. */
  async getCurrentSession(
    record: readonly AiMessage[],
  ): Promise<Result<AiSession, AiFailure>> {
    const heldSession = this.#session;
    if (heldSession !== null && this.#seenTurns === record.length)
      return ok(heldSession);
    heldSession?.close();
    const sessionResult = await openSessionOn(
      this.#provider,
      record,
      this.#system,
    );
    if (!sessionResult.ok) return sessionResult;
    this.#session = sessionResult.value;
    this.#seenTurns = record.length;
    return sessionResult;
  }

  /** Told after a turn it answered, so the next one can reuse it. */
  markAnswered(recordLength: number): void {
    this.#seenTurns = recordLength;
  }

  usage(): ContextUsage {
    return this.#session?.usage() ?? { kind: "unknown" };
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }
}

class RoutedChat implements Orchestrator {
  readonly #parts: OrchestratorParts;
  readonly #sides: Map<Side, SideSession>;
  /** Where a turn goes when nothing decided it: the first side the caller named. */
  readonly #first: Side;
  readonly #judge: SideSession | null;
  #record: readonly AiMessage[];

  constructor(parts: OrchestratorParts) {
    const entries = Object.entries(parts.sides);
    const [firstEntry] = entries;
    // A router with no sides has nothing to route to, and an `escalate` order
    // naming a side that does not exist is a typo that would otherwise surface
    // as a refusal on some turn much later. Both are wrong at construction, so
    // both are said at construction — the one place in this file that throws.
    if (firstEntry === undefined)
      throw new Error("orchestrate: at least one side is needed");
    if (parts.policy.kind === "escalate" && parts.policy.order !== undefined) {
      const order = parts.policy.order;
      if (order.length === 0)
        throw new Error("orchestrate: an escalate order cannot be empty");
      const unknown = order.filter((side) => !(side in parts.sides));
      if (unknown.length > 0)
        throw new Error(
          `orchestrate: the escalate order names sides that do not exist: ${unknown.join(", ")}`,
        );
      if (new Set(order).size !== order.length)
        throw new Error("orchestrate: the escalate order repeats a side");
    }
    this.#parts = parts;
    this.#sides = new Map(
      entries.map(([name, provider]) => [
        name,
        new SideSession(provider, parts.system),
      ]),
    );
    this.#first = firstEntry[0];
    this.#judge =
      parts.policy.kind === "classify"
        ? new SideSession(parts.policy.judge, undefined)
        : null;
    this.#record = [...(parts.history ?? [])];
  }

  readonly record = (): readonly AiMessage[] => this.#record;

  readonly ask = async (
    input: string,
    options?: AskOptions,
  ): Promise<Result<Answer, AiFailure>> => {
    const policy = this.#parts.policy;
    if (policy.kind === "escalate")
      return this.#escalate(input, policy, options);
    const sideResult = await this.#chooseSide(input);
    if (!sideResult.ok) return sideResult;
    return this.#turn(sideResult.value, input, options);
  };

  readonly askStream = async (
    input: string,
    options?: AskOptions,
  ): Promise<Result<ReadableStream<string>, AiFailure>> => {
    const policy = this.#parts.policy;
    // Whole first, then one piece: `escalate` has to see an answer to judge it.
    if (policy.kind === "escalate") {
      const answerResult = await this.#escalate(input, policy, options);
      return answerResult.ok
        ? ok(makeSingleChunkStream(answerResult.value.text))
        : answerResult;
    }
    const sideResult = await this.#chooseSide(input);
    if (!sideResult.ok) return sideResult;
    const side = sideResult.value;
    const sideSession = this.#sides.get(side);
    if (sideSession === undefined) return err(notASide(side, this.#names()));
    const sessionResult = await sideSession.getCurrentSession(this.#record);
    if (!sessionResult.ok) return sessionResult;
    const streamResult = await sessionResult.value.promptStream(input, options);
    if (!streamResult.ok) return streamResult;
    return ok(
      this.#recordingStream(streamResult.value, side, input, sideSession),
    );
  };

  readonly close = (): void => {
    for (const side of this.#sides.values()) side.close();
    this.#judge?.close();
  };

  #names(): readonly Side[] {
    return [...this.#sides.keys()];
  }

  #reportRoute(side: Side, reason: string): Side {
    this.#parts.onRoute?.(side, reason);
    return side;
  }

  /**
   * Which side answers. A refusal here is the caller's own bug — a policy that
   * named something that is not a side — and no route is reported for it:
   * nothing was routed anywhere.
   */
  async #chooseSide(input: string): Promise<Result<Side, AiFailure>> {
    const policy = this.#parts.policy;
    if (policy.kind === "predicate") {
      const chosen = policy.choose(input, this.#record);
      if (!this.#sides.has(chosen)) return err(notASide(chosen, this.#names()));
      return ok(this.#reportRoute(chosen, "predicate"));
    }
    if (policy.kind !== "classify")
      return ok(this.#reportRoute(this.#first, "no policy"));
    return ok(
      await this.#askJudge(input, policy.brief ?? routeBrief(this.#names())),
    );
  }

  /** The judge sees the message and nothing else: it decides where a turn goes, not what it says. */
  async #askJudge(input: string, brief: string): Promise<Side> {
    const judge = this.#judge;
    if (judge === null) return this.#reportRoute(this.#first, "no judge");
    const sessionResult = await judge.getCurrentSession([]);
    if (!sessionResult.ok)
      return this.#reportRoute(
        this.#first,
        `judge unavailable: ${sessionResult.error.kind}`,
      );
    const names = this.#names();
    const answerResult = await sessionResult.value.prompt(
      `${brief}\n\nMessage:\n${input}\n\nAnswer with JSON: {"route":"<one of: ${names.join(", ")}>"}.`,
    );
    if (!answerResult.ok)
      return this.#reportRoute(
        this.#first,
        `judge refused: ${answerResult.error.kind}`,
      );
    const parsedAnswer = parseJson(answerResult.value);
    const route = (parsedAnswer as { route?: unknown } | null)?.route;
    if (typeof route === "string" && this.#sides.has(route))
      return this.#reportRoute(route, "judge");
    return this.#reportRoute(this.#first, "judge answered outside the shape");
  }

  async #turn(
    side: Side,
    input: string,
    options?: AskOptions,
  ): Promise<Result<Answer, AiFailure>> {
    const sideSession = this.#sides.get(side);
    if (sideSession === undefined) return err(notASide(side, this.#names()));
    const sessionResult = await sideSession.getCurrentSession(this.#record);
    if (!sessionResult.ok) return sessionResult;
    const answerResult = await sessionResult.value.prompt(input, options);
    if (!answerResult.ok) return answerResult;
    this.#append(input, answerResult.value, sideSession);
    return ok({
      side,
      text: answerResult.value,
      usage: sideSession.usage(),
    });
  }

  /**
   * Down the order until an answer is accepted. Every side but the last may
   * have its answer thrown away; the last one is asked the ordinary way,
   * because after it there is nothing left to escalate to.
   */
  async #escalate(
    input: string,
    policy: Extract<Policy, { kind: "escalate" }>,
    options?: AskOptions,
  ): Promise<Result<Answer, AiFailure>> {
    const order = policy.order ?? this.#names();
    const lastSide = order.at(-1);
    // The constructor refuses an empty order, so this is the same refusal said
    // where the compiler can see it rather than an assertion hiding it.
    if (lastSide === undefined)
      return err({
        kind: "invalid-input",
        detail: "an escalate order cannot be empty",
      });
    let reason = "only side";
    for (const side of order.slice(0, -1)) {
      const sideSession = this.#sides.get(side);
      if (sideSession === undefined) return err(notASide(side, this.#names()));
      const attemptResult = await this.#askUnrecorded(
        sideSession,
        input,
        options,
      );
      if (attemptResult.ok && policy.accept(attemptResult.value, side)) {
        this.#reportRoute(side, "accepted");
        this.#append(input, attemptResult.value, sideSession);
        return ok({
          side,
          text: attemptResult.value,
          usage: sideSession.usage(),
        });
      }
      reason = attemptResult.ok
        ? `${side} answer rejected`
        : `${side} failed: ${attemptResult.error.kind}`;
    }
    this.#reportRoute(lastSide, reason);
    return this.#turn(lastSide, input, options);
  }

  /**
   * A turn whose answer may be thrown away, so it is not appended here. The
   * side's session did append it to its own transcript; the next
   * `getCurrentSession` finds it stale against the record and reopens, which is
   * the same rule that carries a turn across sides.
   */
  async #askUnrecorded(
    sideSession: SideSession,
    input: string,
    options?: AskOptions,
  ): Promise<Result<string, AiFailure>> {
    const sessionResult = await sideSession.getCurrentSession(this.#record);
    if (!sessionResult.ok) return sessionResult;
    return sessionResult.value.prompt(input, options);
  }

  /** The record grows only on a turn that was kept, and the answering side is current again. */
  #append(input: string, answer: string, sideSession: SideSession): void {
    this.#record = [
      ...this.#record,
      { role: "user", content: input },
      { role: "assistant", content: answer },
    ];
    sideSession.markAnswered(this.#record.length);
  }

  #recordingStream(
    sourceStream: ReadableStream<string>,
    side: Side,
    input: string,
    sideSession: SideSession,
  ): ReadableStream<string> {
    const reader = sourceStream.getReader();
    const answerParts: string[] = [];
    return new ReadableStream<string>({
      pull: async (controller) => {
        const chunk = await reader.read();
        if (chunk.done) {
          // Completed turns only, as the session's own record does it.
          this.#append(input, answerParts.join(""), sideSession);
          this.#reportRoute(side, "streamed");
          controller.close();
          return;
        }
        answerParts.push(chunk.value);
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }
}

export function orchestrate(parts: OrchestratorParts): Orchestrator {
  return new RoutedChat(parts);
}
