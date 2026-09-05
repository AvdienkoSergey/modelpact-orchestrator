/**
 * The real thing, when it is here: `claude` on PATH and a daemon on 11434.
 * Skips loudly otherwise. One-liners and a capped budget, because this spends
 * the account's own money.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { makeOllamaProvider } from "modelpact-providers";

import { makeClaudeCliProvider } from "./claude-cli.js";
import { orchestrate, type Side } from "./orchestrate.js";

const isClaudeHere =
  spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
const isOllamaHere = await (async () => {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
})();

describe.skipIf(!isClaudeHere || !isOllamaHere)(
  "live: claude -p and ollama in one conversation",
  () => {
    test("local, cloud, local — and the third turn saw the second", async () => {
      const sides: Side[] = [];
      let turn = 0;
      const chat = orchestrate({
        local: makeOllamaProvider({ model: "granite4:350m" }),
        cloud: makeClaudeCliProvider({ model: "sonnet", maxBudgetUsd: 0.2 }),
        policy: { kind: "predicate", cloudWhen: () => (turn += 1) === 2 },
        system: "Answer in at most eight words.",
        onRoute: (side) => sides.push(side),
      });

      const firstResult = await chat.ask(
        "My favourite colour is teal. Acknowledge.",
      );
      const secondResult = await chat.ask("Name the capital of France.");
      const thirdResult = await chat.ask(
        "What did I say my favourite colour was?",
      );

      expect(firstResult.ok && secondResult.ok && thirdResult.ok).toBe(true);
      expect(sides).toEqual(["local", "cloud", "local"]);
      expect(chat.record()).toHaveLength(6);
      // The local model was reopened on the whole record, so the answer it gives
      // is about a fact stated before a turn it did not answer.
      if (thirdResult.ok)
        expect(thirdResult.value.text.toLowerCase()).toContain("teal");
      chat.close();
    }, 180_000);
  },
);
