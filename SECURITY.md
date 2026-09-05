# Security

## Supported versions

The latest release, and no branches behind it. A fix goes out as a new version
rather than as a backport.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use
[private vulnerability reporting](https://github.com/AvdienkoSergey/modelpact-orchestrator/security/advisories/new)
on this repository — it is private between you and the maintainer until a fix
exists. Expect an acknowledgement within a week; if the Security tab is closed
to you for any reason, open an ordinary issue saying only that you have
something to report, and it will be moved.

Useful in a report: the version, what you sent, what happened, and what you
expected instead. A failing test is the fastest possible bug report.

## How releases are published

Every version is published from CI by
[trusted publishing](https://docs.npmjs.com/trusted-publishers/): npm trusts
this repository and one workflow file by name, and the runner signs in with a
credential that lives for one publish. There is no long-lived npm token to
leak. Each version carries a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
naming the commit and the workflow that built it, which `npm audit signatures`
verifies.
