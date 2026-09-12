/**
 * The CLI backend on a process made of strings. The lines are the ones a real
 * `claude -p --output-format stream-json --include-partial-messages` printed
 * on 2.1.138, and under `--json-schema` on 2.1.236, so the parser is held to
 * the real shape, not a convenient one. `live.test.ts` is where the real
 * binary runs, when it is there.
 */
import { describe, expect, test } from "vitest";
import { describeContract, CONTRACT_SCHEMA } from "modelpact/testing";
import type { AiProvider } from "modelpact";

import {
  makeClaudeCliProvider,
  type Spawned,
  type Spawner,
} from "./claude-cli.js";

const makeByteStream = (text: string): ReadableStream<BufferSource> =>
  new ReadableStream<BufferSource>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const toNdjsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

interface ScriptOptions {
  readonly answer?: string;
  readonly outputTokens?: number;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly isError?: boolean;
  /** The result line's subtype on an error; with it set, `result` is left out, as the CLI does for a turn cap. */
  readonly errorSubtype?: string;
  readonly delayMs?: number;
  /** What the `StructuredOutput` block carries when the call has a schema. */
  readonly structured?: Record<string, unknown>;
  /** Where the object is printed under a schema: streamed as the block, on the result line only, or nowhere. */
  readonly structuredDelivery?: "stream" | "result" | "none";
}

const streamEvent = (event: unknown): string =>
  toNdjsonLine({ type: "stream_event", event });

const USAGE = {
  input_tokens: 6,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 4,
};

/** A plain turn: text deltas, then the result line. */
const makeTextLines = (options: ScriptOptions): string[] => {
  const answerText = options.answer ?? "one, two, three, four, five";
  const words = answerText.match(/\S+\s*/g) ?? [answerText];
  return [
    toNdjsonLine({ type: "system", subtype: "init", model: "claude-opus-4-7" }),
    streamEvent({ type: "message_start" }),
    ...words.map((text) =>
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    streamEvent({ type: "message_stop" }),
    toNdjsonLine({
      type: "result",
      subtype:
        options.errorSubtype ??
        (options.isError === true ? "error" : "success"),
      is_error: options.isError === true,
      ...(options.errorSubtype !== undefined
        ? {}
        : {
            result: options.isError === true ? "budget exceeded" : answerText,
          }),
      usage: { ...USAGE, output_tokens: options.outputTokens ?? words.length },
    }),
  ];
};

/**
 * A schema turn as 2.1.236 prints it: a remark as a text block, then the
 * object as a `StructuredOutput` tool_use block whose first piece is empty,
 * and the whole object again on the result line.
 */
const makeStructuredLines = (options: ScriptOptions): string[] => {
  const object = options.structured ?? { city: "Paris" };
  const json = JSON.stringify(object);
  const delivery = options.structuredDelivery ?? "stream";
  const half = Math.ceil(json.length / 2);
  const blockLines =
    delivery !== "stream"
      ? []
      : [
          streamEvent({
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", name: "StructuredOutput" },
          }),
          ...["", json.slice(0, half), json.slice(half)].map((partial_json) =>
            streamEvent({
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json },
            }),
          ),
          streamEvent({ type: "content_block_stop", index: 1 }),
        ];
  return [
    toNdjsonLine({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
    }),
    streamEvent({ type: "message_start" }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Ok." },
    }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    ...blockLines,
    streamEvent({ type: "message_stop" }),
    toNdjsonLine({
      type: "result",
      subtype: "success",
      is_error: false,
      ...(delivery === "none"
        ? { result: "Ok." }
        : { result: json, structured_output: object }),
      usage: { ...USAGE, output_tokens: options.outputTokens ?? 3 },
    }),
  ];
};

/** What the CLI prints for one turn, delta by delta, at a pace a test can interrupt. */
const makeScriptStream = (
  options: ScriptOptions,
  args: readonly string[],
): ReadableStream<BufferSource> => {
  const delayMs = options.delayMs ?? 1;
  const encoder = new TextEncoder();
  let step = 0;
  const lines = args.includes("--json-schema")
    ? makeStructuredLines(options)
    : makeTextLines(options);
  return new ReadableStream<BufferSource>({
    pull: async (controller) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const nextLine = lines[step];
      if (nextLine === undefined) {
        controller.close();
        return;
      }
      step += 1;
      controller.enqueue(encoder.encode(nextLine));
    },
  });
};

interface Recorded {
  readonly calls: string[][];
  readonly killed: number;
}

/** A spawner that answers from a script and remembers what it was asked to run. */
const makeSpawner = (
  options: ScriptOptions = {},
): { spawn: Spawner; recorded: Recorded } => {
  const recorded = { calls: [] as string[][], killed: 0 };
  const spawn: Spawner = (args) => {
    recorded.calls.push([...args]);
    if (args[0] === "--version") {
      return {
        stdout: makeByteStream("2.1.138\n"),
        stderr: makeByteStream(""),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }
    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const stdout = makeScriptStream(options, args).pipeThrough(
      new TransformStream<BufferSource, BufferSource>({
        flush: () => {
          resolveExit(options.exitCode ?? 0);
        },
      }),
    );
    const spawned: Spawned = {
      stdout,
      stderr: makeByteStream(options.stderr ?? ""),
      exited,
      kill: () => {
        recorded.killed += 1;
        resolveExit(143);
      },
    };
    return spawned;
  };
  return { spawn, recorded };
};

const makeStubbedProvider = (
  options: ScriptOptions = {},
  contextWindow?: number,
): AiProvider =>
  makeClaudeCliProvider({
    spawn: makeSpawner(options).spawn,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  });

const missingBinary: Spawner = () => ({
  stdout: makeByteStream(""),
  stderr: makeByteStream(""),
  exited: Promise.reject(
    Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
  ),
  kill: () => undefined,
});

describeContract("claude-cli on a scripted process", (scenario) => {
  switch (scenario) {
    case "ready":
      return makeStubbedProvider();
    case "unavailable":
      return makeClaudeCliProvider({ spawn: missingBinary });
    case "needs-download":
      return null;
    case "tiny-window":
      // 6 + 10 + 4 + 5 = 25 counted tokens against a window of 1.
      return makeStubbedProvider({}, 1);
  }
});

const mustOpenSession = async (provider: AiProvider) => {
  const access = await provider.access();
  if (access.kind !== "ready")
    throw new Error(`expected ready, got ${access.kind}`);
  const sessionResult = await access.open({ system: "Be brief." });
  if (!sessionResult.ok)
    throw new Error(`open refused: ${sessionResult.error.kind}`);
  return sessionResult.value;
};

describe("claude-cli mapping", () => {
  test("no binary is unsupported, not a crash", async () => {
    const access = await makeClaudeCliProvider({
      spawn: missingBinary,
    }).access();
    expect(access.kind).toBe("unavailable");
    if (access.kind === "unavailable")
      expect(access.reason.kind).toBe("unsupported");
  });

  test("the conversation is rendered into the prompt, with the new turn last", async () => {
    const { spawn, recorded } = makeSpawner({ answer: "ok" });
    const session = await mustOpenSession(makeClaudeCliProvider({ spawn }));
    await session.prompt("first");
    await session.prompt("second");
    const args = recorded.calls.at(-1) ?? [];
    const promptArg = args[args.indexOf("-p") + 1] ?? "";
    expect(promptArg).toContain("user: first");
    expect(promptArg).toContain("assistant: ok");
    expect(promptArg.endsWith("user: second")).toBe(true);
    // A model behind a contract, not an agent in a repo.
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--json-schema");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("Be brief.");
    session.close();
  });

  test("a schema goes out as --json-schema, and the answer is the object, not the remark beside it", async () => {
    const { spawn, recorded } = makeSpawner();
    const session = await mustOpenSession(makeClaudeCliProvider({ spawn }));
    const answerResult = await session.prompt("Name the capital of France.", {
      schema: CONTRACT_SCHEMA,
    });
    const args = recorded.calls.at(-1) ?? [];
    expect(args[args.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(CONTRACT_SCHEMA),
    );
    // Still none of ours: the tool that carries the object is the CLI's own.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    // Room for the CLI's own turns: the call, and a nudge if text came first.
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
    expect(answerResult.ok).toBe(true);
    if (answerResult.ok) {
      expect(JSON.parse(answerResult.value)).toEqual({ city: "Paris" });
      expect(answerResult.value).not.toContain("Ok.");
    }
    session.close();
  });

  test("a schema turn that prints the object only on the result line still answers with it", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({ structuredDelivery: "result" }),
    );
    const answerResult = await session.prompt("Name it.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(answerResult.ok).toBe(true);
    if (answerResult.ok)
      expect(JSON.parse(answerResult.value)).toEqual({ city: "Paris" });
    session.close();
  });

  test("a schema turn with no object anywhere is a failure, never prose", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({ structuredDelivery: "none" }),
    );
    const answerResult = await session.prompt("Name it.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) {
      expect(answerResult.error.kind).toBe("failed");
      if (answerResult.error.kind === "failed")
        expect(answerResult.error.detail).toContain(
          "without structured output",
        );
    }
    session.close();
  });

  test("an abort kills the process and the turn is reported as aborted", async () => {
    const { spawn, recorded } = makeSpawner({ delayMs: 15 });
    const session = await mustOpenSession(makeClaudeCliProvider({ spawn }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const answerResult = await session.prompt("a long one", {
      signal: controller.signal,
    });
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) expect(answerResult.error.kind).toBe("aborted");
    expect(recorded.killed).toBe(1);
    session.close();
  });

  test("a non-zero exit carries the CLI's stderr as the detail", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        exitCode: 1,
        stderr: "Not logged in. Run claude login.",
      }),
    );
    const answerResult = await session.prompt("hello");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) {
      expect(answerResult.error.kind).toBe("failed");
      if (answerResult.error.kind === "failed")
        expect(answerResult.error.detail).toContain("Not logged in");
    }
    session.close();
  });

  test("a result line flagged is_error is a failure with its own words", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({ isError: true }),
    );
    const answerResult = await session.prompt("hello");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok && answerResult.error.kind === "failed") {
      expect(answerResult.error.detail).toContain("budget exceeded");
      // The subtype names the kind of ending, and it is kept beside the words.
      expect(answerResult.error.detail).toContain("error");
    }
    session.close();
  });

  test("an error with no words in result still says what kind it was", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({ isError: true, errorSubtype: "error_max_turns" }),
    );
    const answerResult = await session.prompt("hello");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok && answerResult.error.kind === "failed")
      expect(answerResult.error.detail).toContain("error_max_turns");
    session.close();
  });

  test("the meter is the result line's counts, all four of them", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({ outputTokens: 7 }, 1000),
    );
    await session.prompt("hello");
    const usage = session.usage();
    expect(usage.kind).toBe("bounded");
    if (usage.kind === "bounded") expect(usage.used).toBe(6 + 10 + 4 + 7);
    session.close();
  });
});
