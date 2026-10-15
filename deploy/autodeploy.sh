#!/usr/bin/env bash
# Pull-based deploy: if origin/main moved, update the checkout, check it, restart pouch.
# Run by pouch-deploy.timer. Logs: journalctl --user -u pouch-deploy
#
# The whole body sits in main() so bash parses it before `git reset` can rewrite this file.
set -euo pipefail

main() {
  local app="${POUCH_APP_DIR:-$HOME/Projects/pouch}"
  local state="${POUCH_DEPLOY_STATE:-$HOME/.local/state/pouch-deploy}"
  local port="${POUCH_PORT:-8787}"
  local max_defer="${POUCH_DEPLOY_MAX_DEFER:-3600}" # seconds to wait for busy sessions
  mkdir -p "$state"
  cd "$app"

  git fetch --quiet origin main
  local old new
  old=$(git rev-parse HEAD)
  new=$(git rev-parse origin/main)
  [[ "$old" == "$new" ]] && { rm -f "$state/waiting"; return 0; }

  # This is also a working copy: only deploy from a clean main that origin/main can
  # fast-forward, so a reset never discards a feature branch, local edits or unpushed commits.
  if [[ "$(git symbolic-ref --quiet --short HEAD)" != main ]]; then
    echo "checkout not on main; skipping"
    return 0
  fi
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "uncommitted changes; skipping"
    return 0
  fi
  if ! git merge-base --is-ancestor "$old" "$new"; then
    echo "local main has commits not on origin/main; skipping"
    return 0
  fi

  # A commit that already failed the check: skip until main moves again.
  if [[ -f "$state/failed" && "$(cat "$state/failed")" == "$new" ]]; then
    return 0
  fi

  # Restarting ends in-flight turns and pending approvals in pouch's own sessions
  # (terminal sessions are separate processes and unaffected). Wait for them, up to max_defer.
  if busy; then
    [[ -f "$state/waiting" && "$(head -1 "$state/waiting")" == "$new" ]] \
      || printf '%s\n%s\n' "$new" "$(date +%s)" >"$state/waiting"
    local since; since=$(sed -n 2p "$state/waiting")
    if (( $(date +%s) - since < max_defer )); then
      echo "main at ${new:0:7}; sessions busy, deferring"
      return 0
    fi
    echo "busy for over ${max_defer}s; deploying anyway"
  fi
  rm -f "$state/waiting"

  echo "deploying ${old:0:7} -> ${new:0:7}"
  git reset --quiet --hard "$new"
  if deps_changed "$old" "$new"; then
    install_deps
  fi

  if ! pnpm run --silent typecheck || ! pnpm run --silent check:web; then
    echo "checks failed on ${new:0:7}; staying on ${old:0:7}"
    rollback "$old" "$new"
    echo "$new" >"$state/failed"
    return 1
  fi

  systemctl --user restart pouch
  if ! healthy; then
    echo "pouch not responding after deploying ${new:0:7}; rolling back to ${old:0:7}"
    rollback "$old" "$new"
    systemctl --user restart pouch
    echo "$new" >"$state/failed"
    return 1
  fi
  rm -f "$state/failed"
  echo "deployed ${new:0:7}"
}

# Any pouch-owned session mid-turn or waiting on an approval?
busy() {
  curl -fsS --max-time 5 -H "authorization: Bearer $(cat "${POUCH_DATA:-$HOME/.config/pouch}/token" 2>/dev/null)" \
    "http://127.0.0.1:$port/api/sessions" 2>/dev/null \
    | node -e '
        let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
          const busy = JSON.parse(d).some(s => s.live && (s.status === "working" || s.status === "needs_you"));
          process.exit(busy ? 0 : 1);
        });'
}

healthy() {
  local i
  for i in {1..15}; do
    sleep 2
    curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$port/" && return 0
  done
  return 1
}

rollback() {
  git reset --quiet --hard "$1"
  if deps_changed "$1" "$2"; then
    install_deps
  fi
}

# Also true while node_modules is still npm's, so the switch to pnpm installs once.
deps_changed() {
  ! git diff --quiet "$1" "$2" -- package.json pnpm-lock.yaml pnpm-workspace.yaml \
    || [[ ! -f node_modules/.modules.yaml ]]
}

install_deps() {
  # pnpm leaves an npm-made node_modules in place, so start clean.
  [[ -f node_modules/.modules.yaml ]] || rm -rf node_modules
  pnpm install --frozen-lockfile
}

main "$@"
exit
