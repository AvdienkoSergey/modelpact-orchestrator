/**
 * The orchestrator is not a provider and does not take the conformance suite:
 * a usage meter and an overflow event belong to one model, and it holds two.
 * What is tested is what it actually promises — which side answers, and that
 * both sides see the whole conversation however it was split between them.
 */
import { describe, expect, test } from "vitest";
import { makeMockProvider, type AiProvider } from "modelpact";

import { orchestrate, type Policy, type Side } from "./orchestrate.js";

/** The mock echoes its input, so what a side says shows what it was handed. */
const makeSideProvider = (tag: string): AiProvider =>
  makeMockProvider({
    delayMs: 1,
    reply: (input) =>
      `${tag} to «${input.slice(0, 24)}» in several words.`.match(
        /\S+\s*/g,
      ) ?? [tag],
  });

/** Answers with how many messages it was opened on, which is the record it saw. */
const makeCountingProvider = (): AiProvider =>
  makeMockProvider({ delayMs: 1, reply: (input) => [`saw:${input}`] });

const makeRoutedChat = (
  policy: Policy,
  onRoute?: (side: Side, reason: string) => void,
) =>
  orchestrate({
    local: makeSideProvider("LOCAL"),
    cloud: makeSideProvider("CLOUD"),
    policy,
    ...(onRoute === undefined ? {} : { onRoute }),
  });

describe("orchestrator", () => {
  test("a predicate picks the side and the record is one conversation", async () => {
    const sides: Side[] = [];
    const chat = makeRoutedChat(
      { kind: "predicate", cloudWhen: (input) => input.startsWith("hard:") },
      (side) => sides.push(side),
    );
    const easyResult = await chat.ask("hi");
    const hardResult = await chat.ask("hard: prove it");
    expect(sides).toEqual(["local", "cloud"]);
    expect(easyResult.ok && easyResult.value.text.startsWith("LOCAL")).toBe(
      true,
    );
    expect(hardResult.ok && hardResult.value.text.startsWith("CLOUD")).toBe(
      true,
    );
    expect(easyResult.ok && easyResult.value.side).toBe("local");
    expect(chat.record()).toHaveLength(4);
    chat.close();
  });

  test("a side sees the turns the other side answered", async () => {
    // local, cloud, local: the third turn is the one that used to be blind.
    let turn = 0;
    const chat = orchestrate({
      local: makeCountingProvider(),
      cloud: makeSideProvider("CLOUD"),
      policy: { kind: "predicate", cloudWhen: () => (turn += 1) === 2 },
    });
    const firstResult = await chat.ask("one");
    await chat.ask("two");
    const thirdResult = await chat.ask("three");
    expect(firstResult.ok && thirdResult.ok).toBe(true);
    if (!firstResult.ok || !thirdResult.ok) return;
    expect(firstResult.value.usage.kind).toBe("bounded");
    expect(thirdResult.value.usage.kind).toBe("bounded");
    if (
      firstResult.value.usage.kind !== "bounded" ||
      thirdResult.value.usage.kind !== "bounded"
    )
      return;

    // The mock's meter counts the words it was opened on plus the turn. Had the
    // local side kept its first session, the third turn would count only its
    // own two turns — `firstResult.used` again, plus this one. Reopened on the
    // record, it also carries the turn the cloud answered.
    const ownTurnsOnly = firstResult.value.usage.used * 2;
    expect(thirdResult.value.usage.used).toBeGreaterThan(ownTurnsOnly);
    expect(chat.record()).toHaveLength(6);
    chat.close();
  });

  test("a warm side is not reopened while it keeps answering", async () => {
    let openCount = 0;
    const watchedProvider: AiProvider = {
      name: "mock",
      access: async (request) => {
        const access = await makeSideProvider("WARM").access(request);
        if (access.kind !== "ready") return access;
        return {
          kind: "ready",
          open: (options) => {
            openCount += 1;
            return access.open(options);
          },
        };
      },
    };
    const chat = orchestrate({
      local: watchedProvider,
      cloud: makeSideProvider("CLOUD"),
      policy: { kind: "predicate", cloudWhen: () => false },
    });
    await chat.ask("one");
    await chat.ask("two");
    await chat.ask("three");
    // Opened once and kept: reopening a model that holds its own transcript
    // costs the state it built, and nothing has gone stale.
    expect(openCount).toBe(1);
    chat.close();
  });

  test("escalate: a rejected local answer is thrown away and never recorded", async () => {
    const reasons: string[] = [];
    const chat = makeRoutedChat(
      { kind: "escalate", accept: (answer) => !answer.startsWith("LOCAL") },
      (_side, reason) => reasons.push(reason),
    );
    const answerResult = await chat.ask("anything");
    expect(answerResult.ok && answerResult.value.side).toBe("cloud");
    expect(reasons).toEqual(["local answer rejected"]);
    expect(
      chat.record().filter((message) => message.content.startsWith("LOCAL")),
    ).toHaveLength(0);
    expect(chat.record()).toHaveLength(2);
    chat.close();
  });

  test("escalate: an accepted answer is kept, and arrives whole", async () => {
    const chat = makeRoutedChat({ kind: "escalate", accept: () => true });
    const streamResult = await chat.askStream("anything");
    if (!streamResult.ok) throw new Error("expected a stream");
    const reader = streamResult.value.getReader();
    let pieceCount = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pieceCount += 1;
    }
    // One piece: the policy has to read the answer before it can judge it.
    expect(pieceCount).toBe(1);
    expect(chat.record()).toHaveLength(2);
    chat.close();
  });

  test("a streamed turn arrives in pieces and lands in the record once", async () => {
    const chat = makeRoutedChat({ kind: "predicate", cloudWhen: () => false });
    const streamResult = await chat.askStream("say something");
    if (!streamResult.ok) throw new Error("expected a stream");
    const reader = streamResult.value.getReader();
    const answerParts: string[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      answerParts.push(chunk.value);
    }
    expect(answerParts.length).toBeGreaterThan(1);
    expect(chat.record()).toHaveLength(2);
    expect(chat.record()[1]?.content).toBe(answerParts.join(""));
    chat.close();
  });

  test("classify: the judge's answer picks the side; anything else means local", async () => {
    const getRoutedSides = async (verdict: string): Promise<Side[]> => {
      const sides: Side[] = [];
      const chat = makeRoutedChat(
        {
          kind: "classify",
          judge: makeMockProvider({ delayMs: 1, reply: () => [verdict] }),
        },
        (side) => sides.push(side),
      );
      await chat.ask("something");
      chat.close();
      return sides;
    };
    expect(await getRoutedSides(JSON.stringify({ route: "cloud" }))).toEqual([
      "cloud",
    ]);
    expect(await getRoutedSides("no idea, sorry")).toEqual(["local"]);
  });

  test("an unavailable side is a refusal, not a throw", async () => {
    const chat = orchestrate({
      local: makeMockProvider({ access: "unavailable" }),
      cloud: makeSideProvider("CLOUD"),
      policy: { kind: "predicate", cloudWhen: () => false },
    });
    const answerResult = await chat.ask("hello");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) expect(answerResult.error.kind).toBe("unsupported");
    chat.close();
  });

  test("a history handed in starts the conversation", async () => {
    const chat = orchestrate({
      local: makeSideProvider("LOCAL"),
      cloud: makeSideProvider("CLOUD"),
      policy: { kind: "predicate", cloudWhen: () => false },
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "quite" },
      ],
    });
    expect(chat.record()).toHaveLength(2);
    await chat.ask("next");
    expect(chat.record()).toHaveLength(4);
    chat.close();
  });
});
