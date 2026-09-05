/**
 * The orchestrator, held for one browser.
 *
 * It lives here rather than in the page because the cloud side is `claude -p`,
 * a child process on this machine. That is also the honest shape of this
 * package: the page is a window onto a Node process, and everything it shows
 * comes out of one `orchestrate()` that is running for real.
 */

import { env } from "node:process";
import type { AiFailure, AiMessage, AiProvider, ContextUsage } from "modelpact";
import { makeOllamaProvider } from "modelpact-providers";
import {
  makeClaudeCliProvider,
  orchestrate,
  type Orchestrator,
  type Policy,
} from "modelpact-orchestrator";

import type {
  AskEvent,
  LogEntry,
  Setup,
  Side,
  SideState,
  State,
  Turn,
  UsageView,
} from "../src/protocol.js";
import { stubCloud, stubJudge, stubLocal } from "./stub-model.js";
import { watch, type Watch } from "./observe.js";

const LOCAL_MODEL = env.LOCAL_MODEL ?? "qwen3:14b";
const JUDGE_MODEL = env.JUDGE_MODEL ?? "granite4:350m";
const CLAUDE_MODEL = env.CLAUDE_MODEL ?? "sonnet";

/** Each failure carries only its own fields; `unsupported` has nothing but the name. */
const detailOf = (failure: AiFailure): string =>
  "detail" in failure ? failure.detail : failure.kind;

/** The brands do not survive JSON, so they are dropped here rather than at the wire. */
const usageView = (usage: ContextUsage): UsageView => {
  switch (usage.kind) {
    case "bounded":
      return {
        kind: "bounded",
        used: usage.used,
        total: usage.total,
        remaining: usage.remaining,
      };
    case "unbounded":
      return { kind: "unbounded", used: usage.used };
    case "unknown":
      return { kind: "unknown" };
  }
};

/** The same rules `npm run chat` runs, so the two demos cannot drift. */
const CLOUD_WHEN = (input: string): boolean =>
  input.length > 240 || /\bwhy\b|\bprove\b|\bdesign\b/i.test(input);

const KEEP_LOCAL = (answer: string): boolean =>
  answer.length > 40 && !/i (don't|do not) know/i.test(answer);

const ollama = (model: string): AiProvider => makeOllamaProvider({ model });

interface SideParts {
  readonly watch: Watch;
  readonly label: string;
  /** Filled on the first `state()` after a rebuild; a `claude --version` per turn is a spawn per turn. */
  probe: { access: SideState["access"]; detail: string | null } | null;
  /** The record length this side has answered up to, as the orchestrator counts it. */
  answeredAt: number;
}

export class Demo {
  #setup: Setup = { policy: "classify", local: "stub", cloud: "stub" };
  #record: readonly Turn[] = [];
  #log: readonly LogEntry[] = [];
  #lastSide: Side | null = null;
  #listener: ((entry: LogEntry) => void) | null = null;
  /** Written during a turn, read once when it is appended, then cleared. */
  #dropped: string | null = null;
  #judged: string | null = null;

  #chat!: Orchestrator;
  #local!: SideParts;
  #cloud!: SideParts;
  #judge: SideParts | null = null;

  constructor() {
    this.#build();
  }

  get setup(): Setup {
    return this.#setup;
  }

  async state(): Promise<State> {
    await this.#probeAll();
    return {
      setup: this.#setup,
      local: this.#sideState("local", this.#local),
      cloud: this.#sideState("cloud", this.#cloud),
      judge: this.#judge === null ? null : this.#sideState(null, this.#judge),
      record: this.#record,
      log: this.#log,
      streams: this.#setup.policy !== "escalate",
    };
  }

  /** The record is handed to the new orchestrator, so a policy can be changed mid-conversation. */
  reconfigure(setup: Setup): void {
    this.#setup = setup;
    this.#build();
    this.#note({
      kind: "setup",
      text: `${setup.policy} · local ${setup.local} · cloud ${setup.cloud} — ${this.#record.length} messages handed over, both sides cold`,
    });
  }

  reset(): void {
    this.#record = [];
    this.#log = [];
    this.#lastSide = null;
    this.#build();
  }

  async ask(input: string, emit: (event: AskEvent) => void): Promise<void> {
    this.#listener = (entry) => {
      emit({ kind: "log", entry });
    };
    this.#dropped = null;
    this.#judged = null;
    try {
      const started = await this.#chat.askStream(input);
      if (!started.ok) {
        this.#note({
          kind: "error",
          text: `${started.error.kind}: ${detailOf(started.error)}`,
        });
        return;
      }
      const reader = started.value.getReader();
      const parts: string[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parts.push(chunk.value);
        emit({ kind: "delta", text: chunk.value });
      }
      // Only a completed turn is appended, which is what the orchestrator did
      // to its own record a moment ago.
      const side = this.#lastSide ?? "local";
      this.#record = [
        ...this.#record,
        { role: "user", content: input },
        {
          role: "assistant",
          content: parts.join(""),
          side,
          ...(this.#dropped === null ? {} : { discarded: this.#dropped }),
          ...(this.#judged === null ? {} : { judged: this.#judged }),
        },
      ];
      this.#sideFor(side).answeredAt = this.#record.length;
    } catch (error) {
      this.#note({ kind: "error", text: String(error) });
    } finally {
      this.#listener = null;
      emit({ kind: "done", state: await this.state() });
    }
  }

  #sideFor(side: Side): SideParts {
    return side === "cloud" ? this.#cloud : this.#local;
  }

  #note(entry: LogEntry): void {
    this.#log = [...this.#log, entry];
    this.#listener?.(entry);
  }

  #build(): void {
    // Undefined only on the first build: a declared field exists before the
    // constructor body runs, and the type says otherwise for every other call.
    const previous: Orchestrator | undefined = this.#chat;
    previous?.close();
    this.#local = this.#part(
      this.#setup.local === "stub" ? stubLocal : ollama(LOCAL_MODEL),
      this.#setup.local === "stub" ? "stub:local" : `ollama · ${LOCAL_MODEL}`,
    );
    this.#cloud = this.#part(
      this.#setup.cloud === "stub"
        ? stubCloud
        : makeClaudeCliProvider({ model: CLAUDE_MODEL, maxBudgetUsd: 0.5 }),
      this.#setup.cloud === "stub" ? "stub:cloud" : `claude · ${CLAUDE_MODEL}`,
    );
    this.#judge =
      this.#setup.policy !== "classify"
        ? null
        : this.#part(
            this.#setup.local === "stub" ? stubJudge : ollama(JUDGE_MODEL),
            this.#setup.local === "stub"
              ? "stub:judge"
              : `ollama · ${JUDGE_MODEL}`,
          );

    this.#chat = orchestrate({
      local: this.#local.watch.provider,
      cloud: this.#cloud.watch.provider,
      policy: this.#policy(),
      system: "Answer briefly.",
      history: this.#record.map(({ role, content }): AiMessage => ({
        role,
        content,
      })),
      onRoute: (side, reason) => {
        this.#lastSide = side;
        const said = this.#judge?.watch.said();
        if (reason.startsWith("judge") && said !== null && said !== undefined) {
          this.#judged = said;
          this.#note({ kind: "judge", said });
        }
        this.#note({ kind: "route", side, reason });
      },
    });
  }

  #part(provider: AiProvider, label: string): SideParts {
    return { watch: watch(provider), label, probe: null, answeredAt: -1 };
  }

  #policy(): Policy {
    switch (this.#setup.policy) {
      case "predicate":
        return { kind: "predicate", cloudWhen: CLOUD_WHEN };
      case "escalate":
        return {
          kind: "escalate",
          accept: (answer) => {
            const keep = KEEP_LOCAL(answer);
            // The one place the thrown-away answer is readable: after this
            // returns false it is gone, and it never enters the record.
            if (!keep) {
              this.#dropped = answer;
              this.#note({ kind: "discard", text: answer });
            }
            return keep;
          },
        };
      case "classify":
        return {
          kind: "classify",
          judge: this.#judge?.watch.provider ?? stubJudge,
        };
    }
  }

  async #probeAll(): Promise<void> {
    await Promise.all(
      [this.#local, this.#cloud, this.#judge].map((part) =>
        part === null ? undefined : this.#probe(part),
      ),
    );
  }

  async #probe(part: SideParts): Promise<void> {
    if (part.probe !== null) return;
    const access = await part.watch.provider.access();
    part.probe =
      access.kind === "unavailable"
        ? { access: "unavailable", detail: detailOf(access.reason) }
        : { access: access.kind, detail: null };
  }

  /**
   * `current` is the orchestrator's own rule read from outside: a side has
   * seen the record up to whichever came later, the conversation it was handed
   * at `open` or the last turn it answered.
   */
  #sideState(side: Side | null, part: SideParts): SideState {
    const opens = part.watch.opens();
    const handed = opens[opens.length - 1]?.history ?? -1;
    return {
      label: part.label,
      access: part.probe?.access ?? "ready",
      detail: part.probe?.detail ?? null,
      opens,
      usage: usageView(part.watch.usage()),
      current:
        side !== null &&
        opens.length > 0 &&
        Math.max(handed, part.answeredAt) === this.#record.length,
    };
  }
}
