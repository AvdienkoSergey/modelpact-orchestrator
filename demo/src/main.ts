/**
 * The page: a window onto one `orchestrate()` running in the dev server.
 *
 * Three things are on show. Which side answered a turn, and on what grounds —
 * the badge and the log. What each side was handed, and when it was reopened,
 * which is the one rule this package makes up on its own. And, under
 * `escalate`, the answer that was read and dropped: it is drawn here because
 * it is the only place it exists, having never entered the record.
 */

import {
  CLOUDS,
  LOCALS,
  POLICIES,
  POLICY_RULE,
  type AskEvent,
  type LogEntry,
  type Setup,
  type SideState,
  type State,
  type Turn,
  type UsageView,
} from "./protocol.js";

const need = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`the demo is missing ${selector}`);
  return found;
};

const recordList = need<HTMLOListElement>("#record");
const composer = need<HTMLFormElement>("#composer");
const input = need<HTMLTextAreaElement>("#input");
const send = need<HTMLButtonElement>("#send");
const reset = need<HTMLButtonElement>("#reset");
const hint = need<HTMLSpanElement>("#hint");
const policyPicker = need<HTMLDivElement>("#policy");
const ruleText = need<HTMLParagraphElement>("#rule");
const sidesBox = need<HTMLDivElement>("#sides");
const logList = need<HTMLOListElement>("#log");

let state: State | null = null;

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
};

const meter = (usage: UsageView): string => {
  if (usage.kind === "unknown") return "no meter";
  if (usage.kind === "unbounded") return `${usage.used} tokens, no ceiling`;
  const share = ((usage.used / usage.total) * 100).toFixed(1);
  return `${usage.used} / ${usage.total} tokens — ${share}%`;
};

/** The reopen rule, said the way the panel has room for. */
const openLine = (side: SideState): string => {
  const last = side.opens[side.opens.length - 1];
  if (last === undefined) return "not opened yet";
  const times = side.opens.length === 1 ? "once" : `${side.opens.length} times`;
  return `opened ${times}, last on ${last.history} messages`;
};

/**
 * `routed` is false for the judge: it is opened on an empty record every time
 * and never answers a turn, so warm and stale are not things it can be.
 */
const drawSide = (
  title: string,
  side: SideState,
  routed: boolean,
): HTMLElement => {
  const card = element("div", "side");
  const head = element("div", "side-head");
  head.append(
    element("strong", "side-name", title),
    element("span", "side-label", side.label),
  );

  const access = element("span", "chip", side.detail ?? side.access);
  access.dataset.kind = side.access;

  const chips = element("div", "row");
  chips.append(access);
  if (routed) {
    const warmth = element(
      "span",
      "chip",
      side.current ? "current" : "will be reopened",
    );
    warmth.dataset.kind = side.current ? "current" : "stale";
    chips.append(warmth);
  }

  card.append(
    head,
    chips,
    element("p", "side-line", openLine(side)),
    element("p", "side-line", meter(side.usage)),
  );
  return card;
};

const drawSides = (current: State): void => {
  const cards = [
    drawSide("local", current.local, true),
    drawSide("cloud", current.cloud, true),
  ];
  if (current.judge !== null)
    cards.push(drawSide("judge", current.judge, false));
  sidesBox.replaceChildren(...cards);
};

const drawPolicy = (setup: Setup): void => {
  const pick = <T extends string>(
    name: string,
    values: readonly T[],
    chosen: T,
    change: (value: T) => Setup,
  ): HTMLElement => {
    const group = element("div", "choice-group");
    group.append(element("span", "choice-name", name));
    for (const value of values) {
      const button = element("button", "choice", value);
      button.dataset.chosen = String(value === chosen);
      button.dataset.testid = `${name}-${value}`;
      button.addEventListener("click", () => {
        void configure(change(value));
      });
      group.append(button);
    }
    return group;
  };

  policyPicker.replaceChildren(
    pick("policy", POLICIES, setup.policy, (policy) => ({ ...setup, policy })),
    pick("local", LOCALS, setup.local, (local) => ({ ...setup, local })),
    pick("cloud", CLOUDS, setup.cloud, (cloud) => ({ ...setup, cloud })),
  );
  ruleText.textContent = POLICY_RULE[setup.policy];
};

const logLine = (entry: LogEntry): HTMLElement => {
  const item = element("li", `log-${entry.kind}`);
  switch (entry.kind) {
    case "route":
      item.append(
        element("code", "side-tag", entry.side),
        document.createTextNode(` ${entry.reason}`),
      );
      return item;
    case "judge":
      item.append(
        document.createTextNode("judge answered "),
        element("code", "", entry.said.trim()),
      );
      return item;
    case "discard":
      item.textContent = `dropped ${entry.text.length} characters`;
      return item;
    case "setup":
      item.textContent = entry.text;
      return item;
    case "error":
      item.textContent = entry.text;
      return item;
  }
};

const drawLog = (entries: readonly LogEntry[]): void => {
  logList.replaceChildren(...entries.map(logLine));
  logList.scrollTop = logList.scrollHeight;
};

const drawTurn = (turn: Turn): HTMLElement => {
  const item = element("li", `turn turn-${turn.role}`);
  if (turn.judged !== undefined)
    item.append(
      element("p", "aside-line", `the judge said ${turn.judged.trim()}`),
    );
  if (turn.discarded !== undefined) {
    const dropped = element("blockquote", "dropped");
    dropped.append(
      element(
        "span",
        "dropped-tag",
        "read, then dropped — never in the record",
      ),
      element("p", "", turn.discarded),
    );
    item.append(dropped);
  }
  const bubble = element("div", "bubble");
  if (turn.side !== undefined)
    bubble.append(element("span", `badge badge-${turn.side}`, turn.side));
  bubble.append(element("p", "", turn.content));
  item.append(bubble);
  return item;
};

const drawRecord = (record: readonly Turn[]): void => {
  recordList.replaceChildren(...record.map(drawTurn));
  if (record.length === 0)
    recordList.append(
      element(
        "li",
        "empty",
        "Nothing yet. Say something short, then ask it why: under every policy here those two go to different sides, and the second answer is opened on the first.",
      ),
    );
  recordList.scrollTop = recordList.scrollHeight;
};

const draw = (next: State): void => {
  state = next;
  drawPolicy(next.setup);
  drawSides(next);
  drawRecord(next.record);
  drawLog(next.log);
  hint.textContent = next.streams
    ? ""
    : "escalate reads the answer before it decides, so this policy cannot stream";
};

const post = async (path: string, body?: unknown): Promise<State> => {
  const answer = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await answer.json()) as State;
};

const configure = async (setup: Setup): Promise<void> => {
  draw(await post("/api/setup", setup));
};

interface Live {
  readonly badge: HTMLSpanElement;
  readonly body: HTMLParagraphElement;
}

/** The turn in progress, drawn before the record it will become. */
const liveTurn = (said: string): Live => {
  const asked = drawTurn({ role: "user", content: said });

  const badge = element("span", "badge badge-waiting", "…");
  const body = element("p", "", "");
  const bubble = element("div", "bubble");
  bubble.append(badge, body);
  const answering = element("li", "turn turn-assistant");
  answering.append(bubble);

  recordList.append(asked, answering);
  recordList.scrollTop = recordList.scrollHeight;
  return { badge, body };
};

const lines = async (
  response: Response,
  onEvent: (event: AskEvent) => void,
): Promise<void> => {
  const body = response.body;
  if (body === null) return;
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let held = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    held += chunk.value;
    const parts = held.split("\n");
    held = parts.pop() ?? "";
    for (const part of parts)
      if (part !== "") onEvent(JSON.parse(part) as AskEvent);
  }
};

const ask = async (said: string): Promise<void> => {
  const live = liveTurn(said);
  // The turn's own entries, kept apart from `state.log`, which is a snapshot
  // from before it started.
  const pending: LogEntry[] = [];
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: said }),
  });
  await lines(response, (event) => {
    if (event.kind === "delta") {
      live.body.textContent += event.text;
      recordList.scrollTop = recordList.scrollHeight;
      return;
    }
    if (event.kind === "log") {
      // The route lands before the first delta, so the bubble is labelled
      // while it is still filling.
      if (event.entry.kind === "route") {
        live.badge.textContent = event.entry.side;
        live.badge.className = `badge badge-${event.entry.side}`;
      }
      pending.push(event.entry);
      drawLog([...(state?.log ?? []), ...pending]);
      return;
    }
    draw(event.state);
  });
};

composer.addEventListener("submit", (submitted) => {
  submitted.preventDefault();
  const said = input.value.trim();
  if (said === "") return;
  input.value = "";
  send.disabled = true;
  void ask(said)
    .catch((error: unknown) => {
      drawLog([...(state?.log ?? []), { kind: "error", text: String(error) }]);
    })
    .finally(() => {
      send.disabled = false;
      input.focus();
    });
});

input.addEventListener("keydown", (pressed) => {
  if (pressed.key === "Enter" && !pressed.shiftKey) {
    pressed.preventDefault();
    composer.requestSubmit();
  }
});

reset.addEventListener("click", () => {
  void post("/api/reset").then(draw);
});

void fetch("/api/state")
  .then(async (answer) => (await answer.json()) as State)
  .then(draw);
