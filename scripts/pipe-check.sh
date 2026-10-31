#!/usr/bin/env bash
# ISC-145: output sent through a pipe arrives whole, from the source and from a compiled binary, and a reader that
# stops early doesn't turn into an error.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
bun build --compile "$ROOT/src/cli.ts" --outfile "$WORK/solobooks" > /dev/null

check() {
  local name=$1
  shift
  "$@" help > "$WORK/help.file"
  local want piped
  want=$(wc -c < "$WORK/help.file")
  piped=$("$@" help | wc -c)
  if [ "$want" -le 65536 ]; then
    echo "FAIL: $name: help is $want bytes, too small to prove anything about a 64 KB pipe" >&2
    exit 1
  fi
  if [ "$want" -ne "$piped" ]; then
    echo "FAIL: $name: $want bytes to a file but $piped through a pipe" >&2
    exit 1
  fi
  "$@" help | bun -e 'JSON.parse(await Bun.stdin.text())'
  local err="$WORK/err"
  local status=0
  { "$@" help 2> "$err" || status=$?; } | head -1 > /dev/null
  if [ "$status" -ne 0 ] && [ "$status" -ne 141 ]; then
    echo "FAIL: $name: help | head -1 exited $status" >&2
    exit 1
  fi
  if [ -s "$err" ]; then
    echo "FAIL: $name: help | head -1 printed an error: $(cat "$err")" >&2
    exit 1
  fi
  echo "ok: $name: $piped bytes through a pipe, valid JSON, and head -1 ends quietly"
}

check source bun "$ROOT/src/cli.ts"
check binary "$WORK/solobooks"
echo "PASS: piped output is whole"
