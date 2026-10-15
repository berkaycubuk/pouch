# Security

pouch is a remote control for Claude Code on your machine. Whoever can use its API can have
Claude run commands with your user's permissions, so treat access to pouch like SSH access.

## What protects it

- **Localhost by default.** It listens on `127.0.0.1`; reach it through `tailscale serve` or
  another HTTPS reverse proxy you control. Don't put it on the open internet.
- **Login token.** Every `/api/*` route and `/ws` need the token from `~/.config/pouch/token`
  (cookie or `Authorization: Bearer`). Delete the file and restart to revoke every device.
  QR login hands the same cookie to a new device, but only after a logged-in device approves it;
  only approve a code shown on your own screen.
  `POUCH_TAILSCALE_USERS` skips the token for those Tailscale logins; use it only when
  `tailscale serve` is the only proxy in front of pouch.
- **Cloudflare Access (optional).** Requests that come through a Cloudflare Tunnel need a valid
  Access JWT (checked against the team's signing keys, audience and expiry) as well as the token,
  and are refused outright if Access isn't configured.
- **Host and Origin checks.** Requests with an unknown `Host` (DNS rebinding) or a cross-site
  `Origin` (CSRF, cross-site WebSocket) are refused.
- **Browser hardening.** A strict CSP (no inline scripts except the hashed importmap, no remote
  images), `nosniff`, no framing, no referrer.
- **Claude's permissions.** Sessions run in Claude Code's `auto` mode (or `default`/`acceptEdits`);
  `bypassPermissions` can't be selected. New tasks only start inside `POUCH_PROJECTS`.

## Reporting a vulnerability

Please report it privately through GitHub's
[security advisories](https://github.com/berkaycubuk/pouch/security/advisories/new)
rather than a public issue.
