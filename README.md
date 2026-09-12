# modelpact-orchestrator

[![npm](https://img.shields.io/npm/v/modelpact-orchestrator)](https://www.npmjs.com/package/modelpact-orchestrator)
[![ci](https://github.com/AvdienkoSergey/modelpact-orchestrator/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/AvdienkoSergey/modelpact-orchestrator/actions/workflows/ci.yml)
![node: ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933)
[![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**Two models in one conversation, and a policy that picks between them. Claude
from the `claude` you already pay for, a local one from Ollama, one record
across both.**

## Install

```sh
npm install modelpact-orchestrator modelpact
```

```ts
import { orchestrate, makeClaudeCliProvider } from "modelpact-orchestrator";
import { makeOllamaProvider } from "modelpact-providers";

const chat = orchestrate({
  local: makeOllamaProvider({ model: "granite4:350m" }),
  cloud: makeClaudeCliProvider({ model: "sonnet", maxBudgetUsd: 0.5 }),
  policy: { kind: "predicate", cloudWhen: (input) => input.length > 240 },
});

const answer = await chat.ask("Name the capital of France.");
if (answer.ok) console.log(answer.value.side, answer.value.text);
```

`ask` and `askStream` take a second argument, `{ schema }`, and pass it on
unchanged to whichever side answers. That side honours it or refuses it, as the
contract has every backend do; the router never drops it on the way. It is the
one per-turn option that crosses a router: a caller above it that asks in a
shape — an agent reading tool calls out of the answer — needs the shape to
reach the model, and for want of this parameter it once got prose from the
local side and had to dig the object out of thirty kilobytes of second thoughts.

The providers are handed in, so this package depends on none of them: any
`AiProvider` fits either side, and the two in the example come from
[modelpact-providers](https://github.com/AvdienkoSergey/modelpact-providers).

## The mistake this package is mostly about

The first version made the router a `ModelBackend` — two backends and a policy,
composed into one, plugged in where a transport goes. It passed the conformance
suite. It was still wrong, and everything that had to be forced said so:

- a usage meter had to pick a side, though two models have two windows and two
  tokenizers, so the number it reported was true of neither;
- an overflow event from one side meant nothing for the other;
- the inner provider had to be reopened every turn to be told about turns it
  had not answered, because a provider keeps its own conversation and a backend
  is handed one;
- `escalate` had to read the local answer whole before judging it, which killed
  streaming from inside a slot whose whole promise is a stream.

Four leaks, one hole. A session is a relationship with **one** model, and every
guarantee it makes assumes that. Two models under one session share a
transcript and nothing else.

There are three storeys, and the router belongs on the third:

| Storey        | What lives there                            | Where                                        |
| ------------- | ------------------------------------------- | -------------------------------------------- |
| transport     | how to reach one model                      | `modelpact-providers`, and `claude-cli` here |
| session       | one conversation, one model, the guarantees | `modelpact`                                  |
| orchestration | several models, a policy, a loop            | this package                                 |

Moved up, nothing has to be forced — and it needed **nothing new** from the
contract, which is the check that a storey is right. `open({ history })` was
already the door for handing a session a conversation it did not have.

## What it is, and honestly is not

`orchestrate()` holds two providers, a record of its own, and a policy. It is
not an `AiSession` and does not pretend to be: `ask()` returns the answer, the
side that gave it, and **that side's** meter. No third meter over two models,
because there is no such thing.

| `policy.kind` | Decides by                                                            |
| ------------- | --------------------------------------------------------------------- |
| `predicate`   | a function of the input — length, a keyword, a privacy marker         |
| `escalate`    | the local answer, whole, kept only if `accept` says so; else cloud    |
| `classify`    | a judge provider asked which way to send it; a small local model fits |

`classify` is two models cooperating: a 350M model decides, a 14B one or Claude
answers.

**How a side is kept in the conversation.** A session that has answered every
turn since it was opened is current, and is left alone — reopening a model that
keeps its own transcript costs the state it built. When the other side has
spoken since, it is reopened on the record. That is the whole rule, and it is a
decision this package makes about its own conversation, not something the
contract had to be talked into.

`escalate` still cannot stream, and that is the policy's cost rather than a
leak: an answer that may be thrown away cannot be shown first. The other two
stream normally.

## The transport underneath

[`src/claude-cli.ts`](src/claude-cli.ts) is `claude -p --output-format
stream-json` as a transport: a child process, deltas on stdout, the answer and
the cost on the last line — and the same four answers every other backend
gives, green on the same conformance suite. Shapes read off 2.1.138, not off
the docs:

- a schema goes out as `--json-schema`, and the answer comes back not as text
  but as a call to the CLI's own `StructuredOutput` tool, streamed as
  `input_json_delta` pieces of one `tool_use` block; the reader switches to
  that block and drops the text beside it, which is the model's remark about
  the answer and not the answer. On 2.1.138 the flag failed with `is_error`
  under `--tools ""`, because the empty list switched that tool off with the
  rest, and a schema was refused up front; 2.1.236 keeps it on, measured, and
  a turn that ends without the block is a failure rather than prose;
- a schema turn runs with `--max-turns 3` where a plain one runs with 1: the
  `StructuredOutput` call is a turn of the CLI's own, and a model that writes a
  sentence first is nudged by the CLI to make the call and needs a third.
  Capped at 1 that ends as `error_max_turns` with `result: null` — the one
  failure that arrived with no words, until the detail learned to carry the
  subtype. Nothing can loop on the extra turns, since that tool is the only one;
- SIGTERM is exit 143, and by then the lifecycle has already errored the stream
  as `aborted`, so it is not reported twice;
- stateless per turn on purpose — rendered history instead of `--resume`, or a
  turn the local side answered would be missing from Claude's context;
- the spawner is structural (`ReadableStream<BufferSource>`, a promise, a
  `kill()`), so the emitted `.d.ts` names nothing from `@types/node`.
  [`tsconfig.surface.json`](tsconfig.surface.json) reads the built declarations
  with `types: []` to keep it that way.

It sits here rather than in `modelpact-providers` for one reason: it is a
process on the developer's own machine, not an endpoint, and this is the only
package that has ever wanted it.

## One more bug it found

A `ReadableStream` pull that returns without enqueueing is not called again
unless a read arrived while it ran. Two housekeeping lines in a row — `init`
then `message_start` — stalled every turn. The same latent bug was in the
WebGPU backend, where two text-less chunks would have done it, and it was
fixed there before it bit.

## The demo

```sh
npm run demo    # then http://127.0.0.1:5175
```

[`demo/`](demo) is one conversation with the machinery beside it: which side
took each turn and on what grounds, each side's own meter, and the reopen
counter — `opened once, last on 4 messages` — which is the one rule this
package makes up rather than inherits. Run local, cloud, local and watch it
move.

Under `escalate` the answer that was read and thrown away is drawn beside the
record, struck through, because that is the only place it exists. It opens on
two stub models, so there is something to poke at with neither `claude` nor a
daemon on the machine; the pickers swap either side for the real thing.

## Tests

[`src/orchestrate.test.ts`](src/orchestrate.test.ts) does **not** run the
conformance suite, because this was never honestly a provider. It tests what it
actually promises, on `makeMockProvider` from the engine: which side answers,
that a warm side is not reopened for nothing, that a rejected answer never
reaches the record, and — the one that matters — local, cloud, local, with the
third turn seeing the second. That test goes red if the reopen rule is removed,
checked by removing it.

[`src/claude-cli.test.ts`](src/claude-cli.test.ts) runs the conformance suite
against a process made of strings, because that one _is_ a provider.
[`src/live.test.ts`](src/live.test.ts) runs the real binary and the real daemon
in one conversation when both are present: it states a fact to the local model,
asks the cloud something else, then asks the local model about the fact — and
skips loudly when either is missing.

```sh
npm test
npm run chat    # a terminal chat; POLICY=predicate|escalate|classify
```

## Scripts

| Script                  | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `npm run typecheck`     | `tsc --noEmit` over `src`                                  |
| `npm run lint`          | ESLint, type-aware                                         |
| `npm run format:check`  | Prettier, check only                                       |
| `npm test`              | Vitest; the live suite skips without `claude` and a daemon |
| `npm run check:surface` | builds, then reads the declarations without `@types/node`  |
| `npm run build`         | `dist/` — JS, declarations, maps                           |
| `npm run demo`          | builds, then serves [`demo/`](demo) on `127.0.0.1:5175`    |
| `npm run chat`          | the same two models in a terminal                          |

## Releases

Versions come from [conventional commits](https://www.conventionalcommits.org)
by way of release-please, and are published to npm from CI by trusted
publishing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
