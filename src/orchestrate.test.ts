/**
 * The orchestrator is not a provider and does not take the conformance suite:
 * a usage meter and an overflow event belong to one model, and it holds
 * several. What is tested is what it actually promises — which side answers,
 * and that every side sees the whole conversation however it was split
 * between them.
 */
import { describe, expect, test } from "vitest";
import { makeMockProvider, type AiProvider } from "modelpact";
import { CONTRACT_SCHEMA } from "modelpact/testing";

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
    sides: {
      local: makeSideProvider("LOCAL"),
      cloud: makeSideProvider("CLOUD"),
    },
    policy,
    ...(onRoute === undefined ? {} : { onRoute }),
  });

describe("orchestrator", () => {
  test("a predicate picks the side and the record is one conversation", async () => {
    const sides: Side[] = [];
    const chat = makeRoutedChat(
      {
        kind: "predicate",
        choose: (input) => (input.startsWith("hard:") ? "cloud" : "local"),
      },
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
      sides: {
        local: makeCountingProvider(),
        cloud: makeSideProvider("CLOUD"),
      },
      policy: {
        kind: "predicate",
        choose: () => ((turn += 1) === 2 ? "cloud" : "local"),
      },
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
      sides: { local: watchedProvider, cloud: makeSideProvider("CLOUD") },
      policy: { kind: "predicate", choose: () => "local" },
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
    const chat = makeRoutedChat({ kind: "predicate", choose: () => "local" });
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

  test("classify: the judge's answer picks the side; anything else means the first", async () => {
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
      sides: {
        local: makeMockProvider({ access: "unavailable" }),
        cloud: makeSideProvider("CLOUD"),
      },
      policy: { kind: "predicate", choose: () => "local" },
    });
    const answerResult = await chat.ask("hello");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) expect(answerResult.error.kind).toBe("unsupported");
    chat.close();
  });

  test("a schema reaches the side that answers, and only on the turn that asked", async () => {
    const chat = orchestrate({
      sides: {
        local: makeMockProvider({
          delayMs: 1,
          reply: () => ["prose ", "answer"],
          schemaReply: JSON.stringify({ city: "Paris" }),
        }),
        cloud: makeSideProvider("CLOUD"),
      },
      policy: { kind: "predicate", choose: () => "local" },
    });
    const shapedResult = await chat.ask("Name the capital of France.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(shapedResult.ok).toBe(true);
    if (shapedResult.ok)
      expect(JSON.parse(shapedResult.value.text)).toEqual({ city: "Paris" });
    const plainResult = await chat.ask("and in a sentence?");
    expect(plainResult.ok && plainResult.value.text).toBe("prose answer");
    // One conversation either way: the shape of a turn is not a fork in the record.
    expect(chat.record()).toHaveLength(4);
    chat.close();
  });

  test("a side that cannot take the schema refuses; the router does not drop it on the way", async () => {
    // The mock without a `schemaReply` refuses a schema, as the contract lets
    // a backend do. What must not happen is the router quietly asking without
    // it and handing back prose to a caller about to parse.
    const chat = makeRoutedChat({ kind: "predicate", choose: () => "local" });
    const answerResult = await chat.ask("Name it.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(answerResult.ok).toBe(false);
    expect(chat.record()).toHaveLength(0);
    chat.close();
  });

  test("a history handed in starts the conversation", async () => {
    const chat = orchestrate({
      sides: {
        local: makeSideProvider("LOCAL"),
        cloud: makeSideProvider("CLOUD"),
      },
      policy: { kind: "predicate", choose: () => "local" },
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

describe("more than two sides", () => {
  const makeLadder = (
    policy: Policy,
    onRoute?: (side: Side, reason: string) => void,
  ) =>
    orchestrate({
      sides: {
        small: makeSideProvider("SMALL"),
        middle: makeSideProvider("MIDDLE"),
        strong: makeSideProvider("STRONG"),
      },
      policy,
      ...(onRoute === undefined ? {} : { onRoute }),
    });

  test("a rung in the middle answers, and the one above it sees that turn", async () => {
    const sides: Side[] = [];
    const order = ["small", "middle", "strong"];
    let turn = 0;
    const chat = makeLadder(
      {
        kind: "predicate",
        choose: () => order[turn++] ?? "small",
      },
      (side) => sides.push(side),
    );
    await chat.ask("one");
    await chat.ask("two");
    const thirdResult = await chat.ask("three");
    expect(sides).toEqual(["small", "middle", "strong"]);
    expect(thirdResult.ok && thirdResult.value.side).toBe("strong");
    // One conversation across three models, not three conversations.
    expect(chat.record()).toHaveLength(6);
    chat.close();
  });

  test("escalate walks the order and stops at the first accepted answer", async () => {
    let strongWasAsked = false;
    const watchedStrong: AiProvider = {
      name: "mock",
      access: async (request) => {
        strongWasAsked = true;
        return makeSideProvider("STRONG").access(request);
      },
    };
    const reasons: string[] = [];
    const chat = orchestrate({
      sides: {
        small: makeSideProvider("SMALL"),
        middle: makeSideProvider("MIDDLE"),
        strong: watchedStrong,
      },
      policy: {
        kind: "escalate",
        accept: (answer) => !answer.startsWith("SMALL"),
      },
      onRoute: (_side, reason) => reasons.push(reason),
    });
    const answerResult = await chat.ask("anything");
    expect(answerResult.ok && answerResult.value.side).toBe("middle");
    expect(reasons).toEqual(["accepted"]);
    // The rung above the accepted one was never reached, so it cost nothing.
    expect(strongWasAsked).toBe(false);
    expect(
      chat.record().filter((message) => message.content.startsWith("SMALL")),
    ).toHaveLength(0);
    chat.close();
  });

  test("escalate keeps the last side's answer whether it is liked or not", async () => {
    const reasons: string[] = [];
    const chat = makeLadder(
      { kind: "escalate", accept: () => false },
      (_side, reason) => reasons.push(reason),
    );
    const answerResult = await chat.ask("anything");
    expect(answerResult.ok && answerResult.value.side).toBe("strong");
    expect(reasons).toEqual(["middle answer rejected"]);
    expect(chat.record()).toHaveLength(2);
    chat.close();
  });

  test("classify: the judge picks any side by name", async () => {
    const sides: Side[] = [];
    const chat = makeLadder(
      {
        kind: "classify",
        judge: makeMockProvider({
          delayMs: 1,
          reply: () => [JSON.stringify({ route: "strong" })],
        }),
      },
      (side) => sides.push(side),
    );
    await chat.ask("something hard");
    expect(sides).toEqual(["strong"]);
    chat.close();
  });

  test("a name that is not a side is the caller's bug, said back as a refusal", async () => {
    const sides: Side[] = [];
    const chat = makeLadder(
      { kind: "predicate", choose: () => "enormous" },
      (side) => sides.push(side),
    );
    const answerResult = await chat.ask("anything");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) {
      expect(answerResult.error.kind).toBe("invalid-input");
      // The refusal says what it could have said, so the typo is visible.
      if (answerResult.error.kind === "invalid-input")
        expect(answerResult.error.detail).toContain("small, middle, strong");
    }
    // Nothing was routed and nothing was said, so neither is reported.
    expect(sides).toEqual([]);
    expect(chat.record()).toHaveLength(0);
    chat.close();
  });

  test("a router with no sides, and an order naming one that does not exist, are refused at once", () => {
    expect(() =>
      orchestrate({
        sides: {},
        policy: { kind: "predicate", choose: () => "x" },
      }),
    ).toThrow(/at least one side/);
    expect(() =>
      orchestrate({
        sides: { small: makeSideProvider("SMALL") },
        policy: {
          kind: "escalate",
          order: ["small", "huge"],
          accept: () => true,
        },
      }),
    ).toThrow(/do not exist: huge/);
  });
});
