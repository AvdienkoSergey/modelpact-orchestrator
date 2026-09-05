/**
 * A terminal chat over two models: Claude from `claude -p`, a local one from
 * Ollama, and a policy deciding which answers. `npm run chat`.
 *
 *   POLICY=predicate|escalate|classify   default classify
 *   LOCAL_MODEL=qwen3:14b                the local side
 *   JUDGE_MODEL=granite4:350m            the judge, classify only
 *   CLAUDE_MODEL=sonnet                  alias or id for the cloud side
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, env } from "node:process";
import { makeOllamaProvider } from "modelpact-providers";

import { makeClaudeCliProvider } from "./claude-cli.js";
import { orchestrate, type Policy } from "./orchestrate.js";

const getPolicy = (): Policy => {
  switch (env.POLICY) {
    case "predicate":
      return {
        kind: "predicate",
        cloudWhen: (input) =>
          input.length > 240 || /\bwhy\b|\bprove\b|\bdesign\b/i.test(input),
      };
    case "escalate":
      return {
        kind: "escalate",
        accept: (answer) =>
          answer.length > 40 && !/i (don't|do not) know/i.test(answer),
      };
    default:
      return {
        kind: "classify",
        judge: makeOllamaProvider({
          model: env.JUDGE_MODEL ?? "granite4:350m",
        }),
      };
  }
};

const main = async (): Promise<void> => {
  const policy = getPolicy();
  const chat = orchestrate({
    local: makeOllamaProvider({ model: env.LOCAL_MODEL ?? "qwen3:14b" }),
    cloud: makeClaudeCliProvider({
      model: env.CLAUDE_MODEL ?? "sonnet",
      maxBudgetUsd: 0.5,
    }),
    policy,
    system: "Answer briefly.",
    onRoute: (side, reason) => stdout.write(`\n  [${side}: ${reason}]\n`),
  });

  const readline = createInterface({ input: stdin, output: stdout });
  stdout.write(`policy=${policy.kind}. Type a message, or /q to quit.\n`);
  // Iterated, not `question()` in a loop: a piped stdin closes the interface at
  // EOF before a second question can be asked, and `for await` drains what it
  // holds and ends cleanly. In a terminal it is the same prompt loop.
  readline.setPrompt("> ");
  readline.prompt();
  for await (const rawLine of readline) {
    const line = rawLine.trim();
    if (line === "/q" || line === "") break;
    const streamResult = await chat.askStream(line);
    if (!streamResult.ok) {
      stdout.write(`  refused: ${streamResult.error.kind}\n`);
      readline.prompt();
      continue;
    }
    const reader = streamResult.value.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout.write(chunk.value);
      }
    } catch (error) {
      stdout.write(`\n  stream error: ${String(error)}`);
    }
    stdout.write(`\n  (${chat.record().length} messages)\n`);
    readline.prompt();
  }
  readline.close();
  chat.close();
};

void main();
