/**
 * What the page and the dev server say to each other.
 *
 * The orchestrator itself never reaches the page: it spawns `claude`, so it
 * lives in Node and the browser is a window onto it. Everything below is the
 * shape of that window, and both halves import it.
 */

export type PolicyName = "predicate" | "escalate" | "classify";
export type LocalName = "stub" | "ollama";
export type CloudName = "stub" | "claude";
export type Side = "local" | "cloud";

export interface Setup {
  readonly policy: PolicyName;
  readonly local: LocalName;
  readonly cloud: CloudName;
}

/** One `open()` on a side, and the conversation it was handed. */
export interface OpenNote {
  readonly at: number;
  readonly history: number;
}

/** `ContextUsage` after JSON: the brands are numbers on the wire. */
export type UsageView =
  | { readonly kind: "unknown" }
  | { readonly kind: "unbounded"; readonly used: number }
  | {
      readonly kind: "bounded";
      readonly used: number;
      readonly total: number;
      readonly remaining: number;
    };

export interface SideState {
  readonly label: string;
  readonly access: "ready" | "needs-download" | "unavailable";
  readonly detail: string | null;
  readonly opens: readonly OpenNote[];
  readonly usage: UsageView;
  /** It answered the last turn in the record, so the orchestrator will reuse it. */
  readonly current: boolean;
}

export interface Turn {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Which side wrote it; absent on the user's own turns. */
  readonly side?: Side;
  /** What `escalate` read and dropped before this answer. It is in no record. */
  readonly discarded?: string;
  /** What the judge answered before this turn was sent anywhere. */
  readonly judged?: string;
}

export type LogEntry =
  | { readonly kind: "route"; readonly side: Side; readonly reason: string }
  /** An answer the policy read and threw away. It is not in the record. */
  | { readonly kind: "discard"; readonly text: string }
  | { readonly kind: "judge"; readonly said: string }
  | { readonly kind: "setup"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export interface State {
  readonly setup: Setup;
  readonly local: SideState;
  readonly cloud: SideState;
  /** Only `classify` has one. */
  readonly judge: SideState | null;
  readonly record: readonly Turn[];
  readonly log: readonly LogEntry[];
  /** True while this policy has to read the answer before it can show it. */
  readonly streams: boolean;
}

/** One NDJSON line of a turn in progress. */
export type AskEvent =
  | { readonly kind: "log"; readonly entry: LogEntry }
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "done"; readonly state: State };

export const POLICIES: readonly PolicyName[] = [
  "predicate",
  "escalate",
  "classify",
];
export const LOCALS: readonly LocalName[] = ["stub", "ollama"];
export const CLOUDS: readonly CloudName[] = ["stub", "claude"];

/** The rules the demo runs, spelled out where the page can print them. */
export const POLICY_RULE: Readonly<Record<PolicyName, string>> = {
  predicate:
    "cloud when the message is over 240 characters, or contains why, prove or design. The input decides, and nothing is asked first.",
  escalate:
    "the local model answers first, whole. The answer is kept only if it is over 40 characters and is not an admission of not knowing; otherwise it is dropped and the cloud is asked. Nothing streams, because an answer that may be thrown away cannot be un-shown.",
  classify:
    "a third, small model reads the message and answers with JSON saying which way it goes. It decides where the turn is sent, not what it says.",
};
