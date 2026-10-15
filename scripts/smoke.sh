#!/usr/bin/env bash
# Boot a throwaway server and check the page, its scripts, every importmap entry and an authed API call.
# Usage: scripts/smoke.sh [port]
set -euo pipefail
cd "$(dirname "$0")/.."

port="${1:-8799}"
data=$(mktemp -d)
POUCH_PORT="$port" POUCH_DATA="$data" node --import tsx src/server.ts >"$data/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$data"' EXIT

base="http://127.0.0.1:$port"
for _ in {1..30}; do
  curl -fsS -o /dev/null "$base/" 2>/dev/null && break
  kill -0 $pid 2>/dev/null || { cat "$data/log"; exit 1; }
  sleep 1
done

fail=0
check() { # path expected-status [curl args...]
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "${@:3}" "$base$1")
  [[ "$code" == "$2" ]] && echo "ok   $1" || { echo "FAIL $1: $code, want $2"; fail=1; }
}
for path in / /app.js /sw.js /style.css /manifest.webmanifest $(grep -o '/vendor/[^"]*' web/index.html); do
  check "$path" 200
done
check /api/sessions 401
check /api/sessions 200 -H "authorization: Bearer $(cat "$data/token")"

(( fail )) && cat "$data/log"
exit $fail
