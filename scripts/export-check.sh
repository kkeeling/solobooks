#!/usr/bin/env bash
# ISC-59 and ISC-61: runs their probes exactly as the ISA writes them, with `solobooks` on PATH and SOLOBOOKS_DIR
# pointing at books filled by one pass through every operation.
#
#   bash scripts/export-check.sh            # `solobooks` runs the source with bun
#   SOLOBOOKS_BIN=/path/to/solobooks bash scripts/export-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
if [ -n "${SOLOBOOKS_BIN:-}" ]; then
  ln -s "$SOLOBOOKS_BIN" "$W/bin/solobooks"
else
  printf '#!/bin/sh\nexec "%s" "%s/src/cli.ts" "$@"\n' "$(command -v bun)" "$ROOT" > "$W/bin/solobooks"
  chmod +x "$W/bin/solobooks"
fi
bun "$ROOT/scripts/scenario-books.ts" "$W/books"
export PATH="$W/bin:$PATH" SOLOBOOKS_DIR="$W/books"

# ISC-59, as written.
solobooks export --year 2026 --format csv > /tmp/y.csv && test -s /tmp/y.csv
echo "ISC-59 ok: $(($(wc -l < /tmp/y.csv) - 1)) transaction rows in one file"

# ISC-61, as written.
solobooks export --format hledger > /tmp/j.journal && hledger -f /tmp/j.journal check
echo "ISC-61 ok: hledger check passed on $(grep -c '^[0-9]' /tmp/j.journal) transactions"
