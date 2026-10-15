# Contributing

Issues and PRs are welcome. pouch is a personal project, so there's no support promise, and
features that make it bigger or heavier may be turned down. For anything large, open an issue first.

## Setup

```sh
pnpm install
POUCH_PORT=8790 POUCH_DATA=$(mktemp -d) pnpm run dev
```

A separate `POUCH_DATA` keeps the dev server's token, settings and push keys apart from a pouch you
already run. Sessions are still real Claude Code sessions in your `~/.claude`.

## Before opening a PR

- `pnpm run typecheck`, `pnpm run check:web` and `pnpm run smoke` pass (CI runs all three).
- The UI is phone-first: check the change at phone width, with touch in mind. Add before/after
  screenshots to the PR for anything visible.
- Keep it small and dependency-light. The frontend has no build step: a new frontend dependency
  needs a `pnpm add` plus an importmap entry in `web/index.html`.
- Match the existing style: 2-space indent, single quotes, short comments only where the reason
  isn't obvious.

Security issues: see [SECURITY.md](SECURITY.md), not a public issue.

`CLAUDE.md` has the code layout and conventions, for people and for Claude Code alike.
