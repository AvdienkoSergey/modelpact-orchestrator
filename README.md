# modelpact-orchestrator

Two models under one session: Claude from the terminal you already pay for, and a local one from Ollama, routed by a condition

## Install

```sh
npm install modelpact-orchestrator modelpact
```

`modelpact` is a peer dependency: this package is built against its contract
and does not carry a copy of it.

## Scripts

| Script                 | What it does                     |
| ---------------------- | -------------------------------- |
| `npm run typecheck`    | `tsc --noEmit` over `src`        |
| `npm run lint`         | ESLint, type-aware               |
| `npm run format:check` | Prettier, check only             |
| `npm test`             | Vitest, once                     |
| `npm run test:watch`   | Vitest, watching                 |
| `npm run build`        | `dist/` — JS, declarations, maps |

## Releases

Versions come from [conventional commits](https://www.conventionalcommits.org)
by way of release-please, and are published to npm from CI by trusted
publishing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
