# pouch

Phone UI for Claude Code sessions on a dev box: a Fastify server on the Claude Agent SDK, plus a
Preact frontend with no build step. README.md covers features and setup.
This file covers what you need to change the code safely.

## Running it while you work on it

pouch may be running *this* session. If the checkout you're in is the one a live `pouch` service
runs from:

- **Don't restart or stop the service** (`systemctl --user restart pouch`). That kills every live
  session, maybe including yours.
- **Work in a worktree**, not in the live checkout: `git worktree add ../pouch-<topic> -b <topic>`.
  With auto-deploy on, a branch or local edits left in the live checkout block deploys.
- To try a change, run a second server on another port with its own data dir:
  `POUCH_PORT=8790 POUCH_DATA=$(mktemp -d) pnpm start`. Stop it when done.

## Commands

- `pnpm install`, not npm (there's only a pnpm lockfile).
- `pnpm run typecheck`: type-checks `src/`. `pnpm run check:web`: syntax-checks `web/app.js` and `web/sw.js`.
  Deploys run both.
- `pnpm run smoke`: boots a throwaway server and checks the page, vendor files and an API call.
  CI (`.github/workflows/check.yml`) runs all three on every PR. There are no tests.
- `pnpm start` / `pnpm run dev`: run with tsx (no compile step). TypeScript only covers `src/`.

## Layout

- `src/server.ts`: HTTP API under `/api/*`, the `/ws` broadcast socket, and static `web/`.
  `/vendor/:file` serves frontend libs from `node_modules`.
- `src/sessions.ts`: `SessionManager`. `start()` holds the SDK `query()` options (system
  prompt preset, `auto` permission mode, `canUseTool`). It also handles approvals and questions (`Pending`),
  resume, and reaping idle sessions.
- `src/events.ts`: turns SDK and transcript messages into the UI's event list.
- `src/terminal.ts`: finds sessions open in terminal Claude processes (`~/.claude/sessions/<pid>.json`).
- `src/shells.ts`: `ShellManager`, PTY shells (node-pty) for the Terminal screen, attached over
  `/api/shells/:id/ws`. Unrelated to `terminal.ts`.
- `src/git.ts`: read-only git calls for the Changes screen.
- `src/push.ts`: Web Push. Keys and subscriptions live in `~/.config/pouch/`.
- `src/auth.ts`: the login token (cookie or Bearer) and the optional Tailscale-identity bypass.
  `server.ts` checks it for every `/api/*` route and `/ws`.
- `src/queue.ts`: the `AsyncQueue` that feeds user messages into a streaming `query()`.
- `web/app.js`: the whole frontend in one file: Preact + `htm` tagged templates, no JSX, no
  bundler. Imports resolve through the importmap in `web/index.html`. A new frontend dependency
  needs a `pnpm add` plus an importmap entry.
- `web/sw.js`: service worker for notifications and their Approve/Deny actions.
- `deploy/`: systemd units, plus the optional `autodeploy.sh` (pull-based, rolls back on failure).

## Conventions

- Sessions are normal Claude Code sessions: no separate database. Session state comes from the
  SDK (`listSessions`, `getSessionInfo`, transcripts), so terminal `claude --resume` keeps working.
- Anything that runs `claude` gets its env from `claudeEnv()` (`src/settings.ts`), which drops
  `ANTHROPIC_API_KEY` unless `POUCH_USE_API_KEY=1`, so a stray key never overrides the plan login.
- The UI is phone-first: check layout at a narrow width and with touch in mind.
- Keep the code small and dependency-light. Match the existing style: 2-space indent, single
  quotes, terse comments only where the reason isn't obvious.
- Agent SDK options and types are documented in
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Check there before guessing.
