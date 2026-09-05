# modelpact-orchestrator demo

One conversation, two models, and the machinery that decided which of them
took each turn.

```sh
npm install          # from the repository root — the demo is a workspace
npm run demo         # builds the package, then serves the demo
```

Then <http://127.0.0.1:5175>. It opens on two stub models, so there is
something to poke at before anything is installed.

## What is on the screen

**The record, on the left.** One transcript, and a badge on each answer saying
which side gave it. That is the whole claim: a session is one model's, so two
models under one session share a record and nothing else.

Say something short, then ask it why. The first turn goes one way and the
second the other, and the second answer reports how many messages it was opened
on — including the turn it did not take.

**The policy, top right.** Three of them, switched mid-conversation: the record
is handed to the new orchestrator through `history`, which is the same door a
side is reopened on.

| Policy      | Decides by                                                         |
| ----------- | ------------------------------------------------------------------ |
| `predicate` | the input alone — over 240 characters, or `why`, `prove`, `design` |
| `escalate`  | the local answer, read whole, kept only if `accept` says so        |
| `classify`  | a third, small model asked which way the turn goes                 |

Under `escalate` the send button stops streaming and says why. The answer that
was read and dropped is drawn beside the record, struck through: it is the only
place it exists, having never been appended anywhere.

**The two sides, below that.** Each carries its own meter, and there is no
third — two models have two windows and two tokenizers, and a number over both
would be true of neither.

The line under the chips is the rule this package makes up on its own:

> `opened once, last on 4 messages` · `current` / `will be reopened`

A side that has answered every turn since it was opened is left alone;
reopening a model that keeps its own transcript costs the state it built. When
the other side has spoken since, it is reopened on the record. Run local,
cloud, local and watch the count go to two — remove the rule from
[`../src/orchestrate.ts`](../src/orchestrate.ts) and the third turn arrives at
a model that never heard the second.

## The four backends

| Pick           | What answers                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| local `stub`   | [`server/stub-model.ts`](server/stub-model.ts) — words about what it was handed  |
| local `ollama` | `qwen3:14b` on a daemon at `127.0.0.1:11434`, if you have one                    |
| cloud `stub`   | the same, with a bigger window and slower deltas                                 |
| cloud `claude` | `claude -p`, spawned on this machine, billed to the terminal you already pay for |

`classify`'s judge follows the local pick: the stub judge, or `granite4:350m`.
Override any of them with `LOCAL_MODEL`, `JUDGE_MODEL` or `CLAUDE_MODEL` in the
environment. A backend that is not there says so in its chip rather than
failing at the first turn.

The stubs are not `makeMockProvider`: they read `request.history`, because a
stub that ignored it could not show a turn seeing what the other side answered,
and that is the only thing worth showing here.

## Why there is a server at all

The cloud side is a child process, so it cannot run in a page.
[`server/state.ts`](server/state.ts) holds one real `orchestrate()` and the
browser is a window onto it — one per Vite process, which is right for a demo
you run on your own machine. There is no `build` script for the same reason:
the dev server is half the demo, not scaffolding around a static page.

Two things on the screen are not on the package's public surface, and
[`server/observe.ts`](server/observe.ts) is how they get there. Each side is
handed in wrapped, so every `open` is noted with the conversation it was given
— that is the reopen counter. The same wrapper reads the meter, which
`askStream` has nowhere to return, and the judge's raw answer, which the
orchestrator parses and keeps to itself.
