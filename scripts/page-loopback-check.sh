#!/bin/sh
# ISC-104: the page server listens only on loopback. Builds the solobooks binary, serves throwaway books with it,
# runs the ISA probe against the running process, and stops it. `lsof -c solobooks` matches by process name, which
# is why this runs the compiled binary and not `bun src/cli.ts`.
#
#   sh scripts/page-loopback-check.sh            # port 7399, or SOLOBOOKS_PORT
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/solobooks-loopback.XXXXXX")
PORT=${SOLOBOOKS_PORT:-7399}
PID=""
cleanup() {
  status=$?
  if [ -n "$PID" ]; then kill "$PID" 2> /dev/null && wait "$PID" 2> /dev/null || true; fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

bun build --compile "$ROOT/src/cli.ts" --outfile "$WORK/solobooks" > /dev/null
"$WORK/solobooks" client add --name Acme --source test:loopback-check --books "$WORK/books" > /dev/null

"$WORK/solobooks" serve --books "$WORK/books" --port "$PORT" > "$WORK/serve.out" 2>&1 &
PID=$!
i=0
until grep -q serving "$WORK/serve.out" 2> /dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 100 ] || ! kill -0 "$PID" 2> /dev/null; then
    echo "FAIL: solobooks serve didn't start:" >&2
    cat "$WORK/serve.out" >&2
    exit 1
  fi
  sleep 0.1
done

echo "solobooks serve is listening on:"
lsof -nP -iTCP -sTCP:LISTEN -a -c solobooks
# The probe below passes when nothing listens at all, so first prove the server is there to be checked.
if ! lsof -nP -iTCP -sTCP:LISTEN -a -c solobooks | rg -q LISTEN; then
  echo "FAIL: lsof found no listening socket for solobooks" >&2
  exit 1
fi

# The ISA probe, as written in Test Strategy for ISC-104.
if lsof -iTCP -sTCP:LISTEN -a -c solobooks | rg -v "127.0.0.1|localhost|\[::1\]" | rg -c LISTEN ; test $? -eq 1; then
  echo "PASS: solobooks serve listens only on loopback"
else
  echo "FAIL: solobooks serve listens beyond loopback" >&2
  exit 1
fi
