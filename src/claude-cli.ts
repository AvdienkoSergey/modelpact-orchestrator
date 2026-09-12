/**
 * Claude, from the terminal you already pay for.
 *
 * `claude -p` is a subprocess that prints NDJSON: `stream_event` lines carry
 * the deltas, one `result` line carries the answer, the usage and the cost.
 * That is a third transport after HTTP and an in-page class, and the one thing
 * this backend exists to show — the four answers are the same, the wire is a
 * child process.
 *
 * Stateless per turn on purpose. `--resume` would let the CLI keep the
 * conversation, but a router that hands turns to different backends needs
 * every backend to read `request.history`, so the conversation is rendered
 * into the prompt each time and nothing is left in the CLI's own session store.
 *
 * Shapes were read off `claude` 2.1.138 with `--include-partial-messages`, and
 * the structured-output shape off 2.1.236; nothing here is from the docs.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  AiError,
  contextUsage,
  createProvider,
  err,
  ndjsonLines,
  ok,
  tokens,
  type AiFailure,
  type AiMessage,
  type AiProvider,
  type Availability,
  type ConnectOptions,
  type ContextUsage,
  type GenerateRequest,
  type ModelConnection,
  type ModelBackend,
  type Result,
} from "modelpact/backend";

/**
 * What the backend needs of a child process, and no more. Structural so that
 * the emitted `.d.ts` names nothing from `@types/node`: a consumer without it
 * still compiles this package, and a test hands in a process made of strings.
 */
export interface Spawned {
  readonly stdout: ReadableStream<BufferSource>;
  readonly stderr: ReadableStream<BufferSource>;
  /** Exit code, or null when a signal ended it. Rejects when it could not start. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type Spawner = (args: readonly string[]) => Spawned;

export interface ClaudeCliConfig {
  /** An alias the CLI accepts (`opus`, `sonnet`) or a full model id. Absent, the CLI's default. */
  readonly model?: string;
  /** The window the meter is measured against; the CLI reports usage, not a limit. */
  readonly contextWindow?: number;
  /** A ceiling the CLI enforces per call, in dollars. */
  readonly maxBudgetUsd?: number;
  /** The executable; `claude` on PATH unless said otherwise. */
  readonly command?: string;
  /** For a test: a process that answers from strings. */
  readonly spawn?: Spawner;
}

const DEFAULTS = { contextWindow: 200_000, command: "claude" };

/**
 * The CLI's own tool that carries structured output, and the one tool that
 * `--tools ""` leaves switched on. Under `--json-schema` the answer is a call
 * to it, not text.
 */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const ZERO_TOKENS = tokens(0) ?? (0 as never);

const makeRealSpawner =
  (command: string): Spawner =>
  (args) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    return {
      stdout: Readable.toWeb(child.stdout) as ReadableStream<BufferSource>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<BufferSource>,
      exited,
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  };

const getSpawner = (config: ClaudeCliConfig): Spawner =>
  config.spawn ?? makeRealSpawner(config.command ?? DEFAULTS.command);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * The `result` line under a schema carries the object whole as well:
 * `structured_output` as a value, `result` as its JSON text. Read when no piece
 * of it came through the stream.
 */
const readStructuredResult = (line: Record<string, unknown>): string | null => {
  const wholeObject = asRecord(line.structured_output);
  if (wholeObject !== null) return JSON.stringify(wholeObject);
  const resultText = line.result;
  return typeof resultText === "string" &&
    asRecord(parseJson(resultText)) !== null
    ? resultText
    : null;
};

/**
 * The CLI's own words for a failed turn. `result` carries them for a budget
 * or an API error; a turn that ended some other way — the turn cap, say —
 * leaves it empty and says why in `subtype`, and a detail that only said
 * "claude reported an error" hid exactly the case worth reading.
 */
const describeCliError = (line: Record<string, unknown>): string => {
  const words = typeof line.result === "string" ? line.result.trim() : "";
  const subtype = typeof line.subtype === "string" ? line.subtype : "";
  const status =
    typeof line.api_error_status === "number"
      ? `api status ${line.api_error_status}`
      : "";
  const parts = [words, subtype, status].filter((part) => part !== "");
  return parts.length === 0
    ? "claude reported an error"
    : `claude reported an error: ${parts.join(", ")}`;
};

const readAllText = async (
  stream: ReadableStream<BufferSource>,
): Promise<string> => {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += chunk.value;
  }
};

/** Ready when `--version` exits 0; unsupported when the binary is not there. */
const getAvailability = async (
  config: ClaudeCliConfig,
): Promise<Availability> => {
  try {
    const probe = getSpawner(config)(["--version"]);
    void readAllText(probe.stdout);
    void readAllText(probe.stderr);
    const code = await probe.exited;
    if (code === 0) return { kind: "ready" };
    return {
      kind: "unavailable",
      reason: { kind: "failed", detail: `claude --version exited ${code}` },
    };
  } catch (cause) {
    return { kind: "unavailable", reason: { kind: "unsupported", cause } };
  }
};

/**
 * The conversation as one prompt. Lossy against real turns, and honest about
 * it: the CLI takes a single prompt, and a router needs history from outside
 * the CLI's own store.
 */
const renderPrompt = (history: readonly AiMessage[], input: string): string => {
  if (history.length === 0) return input;
  const earlierTurns = history
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join("\n\n");
  return `<conversation>\n${earlierTurns}\n</conversation>\n\nuser: ${input}`;
};

const CONTINUE_INSTRUCTION =
  "When a <conversation> block is present, it is the conversation so far; reply to the final user turn only, without restating it.";

class ClaudeCliConnection implements ModelConnection {
  readonly #config: ClaudeCliConfig;
  readonly #system: string | undefined;
  #usedTokens = 0;

  constructor(config: ClaudeCliConfig, options: ConnectOptions) {
    this.#config = config;
    this.#system = options.session.system;
  }

  readonly generateStream = (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<ReadableStream<string>, AiFailure>> => {
    const args = this.#toCliArgs(input, request);
    let child: Spawned;
    try {
      child = getSpawner(this.#config)(args);
    } catch (cause) {
      return Promise.resolve(
        err({ kind: "failed", detail: "could not start claude", cause }),
      );
    }
    const isStructured = request.schema !== undefined;
    return Promise.resolve(
      ok(this.#toDeltaStream(child, request.signal, isStructured)),
    );
  };

  readonly usage = (): ContextUsage =>
    contextUsage(
      tokens(this.#usedTokens) ?? ZERO_TOKENS,
      this.#config.contextWindow ?? DEFAULTS.contextWindow,
    );

  /** Every turn is its own process and it has already exited; nothing is held. */
  readonly dispose = (): void => undefined;

  #toCliArgs(input: string, request: GenerateRequest): string[] {
    const system = [this.#system, CONTINUE_INSTRUCTION]
      .filter(Boolean)
      .join("\n\n");
    // One turn is the whole of a plain answer. Under a schema the CLI spends
    // turns of its own: the `StructuredOutput` call is one, and a model that
    // writes a sentence first is nudged by the CLI — "[structured-output-
    // enforce] You MUST call the StructuredOutput tool" — and needs a third.
    // Capped at 1 that ends as `error_max_turns` with an empty `result`;
    // measured on 2.1.236, and the extra turns can loop on nothing, since
    // `--tools ""` leaves that one tool and no other.
    const maxTurns = request.schema === undefined ? "1" : "3";
    const args = [
      "-p",
      renderPrompt(request.history, input),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--max-turns",
      maxTurns,
      "--no-session-persistence",
      // No tools: this is a model behind a contract, not an agent in a repo.
      "--tools",
      "",
      "--system-prompt",
      system,
    ];
    if (this.#config.model !== undefined)
      args.push("--model", this.#config.model);
    if (this.#config.maxBudgetUsd !== undefined)
      args.push("--max-budget-usd", String(this.#config.maxBudgetUsd));
    // Structured output rides on the CLI's own `StructuredOutput` tool, which
    // is why this flag failed under `--tools ""` on 2.1.138: the empty list
    // switched that tool off with the rest, and the turn came back `is_error`.
    // 2.1.236 keeps it on, measured, and the answer arrives as that tool's
    // input rather than as text — the reader below knows.
    if (request.schema !== undefined)
      args.push("--json-schema", JSON.stringify(request.schema));
    return args;
  }

  /**
   * Deltas out of the NDJSON, usage out of the last line. The abort is the
   * lifecycle's to notice; what is ours is to stop the process when it does,
   * and to close rather than error when the CLI itself ended the turn.
   *
   * Under a schema the answer is not the text. The CLI delivers structured
   * output as a call to its own `StructuredOutput` tool, streamed as the
   * `input_json_delta` pieces of one `tool_use` block, and a text block beside
   * it is the model's remark about the answer ("Ok.") rather than the answer.
   * Measured on 2.1.236. So in that mode the text is dropped, the pieces of
   * that one block are the stream, and a turn that ends without the block is
   * a failure — never prose handed to a caller that is about to parse it.
   */
  #toDeltaStream(
    child: Spawned,
    signal: AbortSignal,
    isStructured: boolean,
  ): ReadableStream<string> {
    const lineReader = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(ndjsonLines())
      .getReader();
    const stderrText = readAllText(child.stderr);
    // Once: the abort and the lifecycle's cancel both reach it, and one
    // SIGTERM is the message.
    let isStopped = false;
    const stopChild = (): void => {
      if (isStopped) return;
      isStopped = true;
      signal.removeEventListener("abort", stopChild);
      child.kill();
    };
    signal.addEventListener("abort", stopChild, { once: true });

    let structuredIndex: number | null = null;
    let hasStructuredOutput = false;

    const readStructuredDelta = (
      event: Record<string, unknown>,
    ): string | null => {
      if (event.type === "content_block_start") {
        const block = asRecord(event.content_block);
        if (
          block?.type === "tool_use" &&
          block.name === STRUCTURED_OUTPUT_TOOL &&
          typeof event.index === "number"
        )
          structuredIndex = event.index;
        return null;
      }
      if (
        event.type !== "content_block_delta" ||
        event.index !== structuredIndex
      )
        return null;
      const delta = asRecord(event.delta);
      const piece =
        delta?.type === "input_json_delta" ? delta.partial_json : null;
      // The first piece on the wire is empty, and an empty enqueue is a pull
      // that made no progress.
      if (typeof piece !== "string" || piece === "") return null;
      hasStructuredOutput = true;
      return piece;
    };

    const readDelta = (line: Record<string, unknown>): string | null => {
      if (line.type !== "stream_event") return null;
      const event = asRecord(line.event);
      if (event === null) return null;
      if (isStructured) return readStructuredDelta(event);
      if (event.type !== "content_block_delta") return null;
      const delta = asRecord(event.delta);
      return delta?.type === "text_delta" && typeof delta.text === "string"
        ? delta.text
        : null;
    };

    return new ReadableStream<string>({
      // A pull must make progress — enqueue, close or throw — before it
      // returns. One that returns empty-handed is not called again unless a
      // read arrived while it ran, and two housekeeping lines in a row
      // (`init`, `message_start`) are enough to leave a reader waiting for
      // ever. Measured, not reasoned: the stream stalled after exactly the
      // second skip.
      pull: async (controller) => {
        for (;;) {
          const nextLine = await lineReader.read();
          if (nextLine.done) {
            signal.removeEventListener("abort", stopChild);
            const code = await child.exited;
            // 143 is SIGTERM, our own kill: the lifecycle has already errored
            // the stream as `aborted` by the time this is reached.
            if (code !== 0 && code !== null && code !== 143) {
              const stderrDetail = (await stderrText).trim();
              throw new AiError({
                kind: "failed",
                detail:
                  stderrDetail === "" ? `claude exited ${code}` : stderrDetail,
              });
            }
            if (isStructured && !hasStructuredOutput && code !== 143)
              throw new AiError({
                kind: "failed",
                detail: "claude answered without structured output",
              });
            controller.close();
            return;
          }
          const line = asRecord(parseJson(nextLine.value));
          if (line === null) continue;
          if (line.type === "result") {
            this.#finishTurn(line);
            // A CLI that prints the block without partial messages still puts
            // the whole object on this line.
            const wholeObject =
              isStructured && !hasStructuredOutput
                ? readStructuredResult(line)
                : null;
            if (wholeObject !== null) {
              hasStructuredOutput = true;
              controller.enqueue(wholeObject);
              return;
            }
          }
          const delta = readDelta(line);
          if (delta !== null) {
            controller.enqueue(delta);
            return;
          }
        }
      },
      cancel: stopChild,
    });
  }

  /** The `result` line: the CLI's own error flag, and the counts for the meter. */
  #finishTurn(line: Record<string, unknown>): void {
    if (line.is_error === true)
      throw new AiError({ kind: "failed", detail: describeCliError(line) });
    const usage = asRecord(line.usage) ?? {};
    this.#usedTokens =
      asNumber(usage.input_tokens) +
      asNumber(usage.cache_read_input_tokens) +
      asNumber(usage.cache_creation_input_tokens) +
      asNumber(usage.output_tokens);
  }
}

export function makeClaudeCliProvider(
  config: ClaudeCliConfig = {},
): AiProvider {
  return createProvider(makeClaudeCliBackend(config));
}

/** The backend itself, for composing under a router rather than opening alone. */
export function makeClaudeCliBackend(
  config: ClaudeCliConfig = {},
): ModelBackend {
  return {
    name: "claude-cli",
    modalities: ["text"],
    availability: () => getAvailability(config),
    connect: (options) =>
      Promise.resolve(ok(new ClaudeCliConnection(config, options))),
  };
}
