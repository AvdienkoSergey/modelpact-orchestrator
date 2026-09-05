# Contributing

## Getting set up

```sh
git clone https://github.com/AvdienkoSergey/modelpact-orchestrator
cd modelpact-orchestrator
npm ci
npm test
```

Node 22 or newer, which is what [`.nvmrc`](.nvmrc) says and what CI installs.

`npm ci` works on any npm that ships with it. `npm install` — adding or
bumping a dependency — wants npm 11 or newer: npm 10 crashes with
`Cannot read properties of null (reading 'edgesOut')` resolving vitest 4's
tree. `npm install -g npm@latest` once, and it is behind you.

## What CI runs, and how to run it first

CI is the reviewer that has to say yes before a human looks. All of it runs
locally:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

## Commits

[Conventional commits](https://www.conventionalcommits.org) — release-please
reads them to decide the next version and to write
[`CHANGELOG.md`](CHANGELOG.md). `feat:` is a minor, `fix:` a patch, and a `!`
after the type is a major:

```
feat: an OpenAI-compatible backend
fix: a cancelled reader no longer frees the next turn
refactor!: name the connection a connection
```

The subject is a sentence about what changed for the reader, not a label. The
body is where the reason goes.

## Pull requests

One change per pull request, against `main`. Say what a reader gets that they
did not have before, and what you measured. A behaviour change wants a test
that goes red without it.
