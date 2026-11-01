#!/usr/bin/env bash
# ISC-184: every probe in scripts/ that needs no other app, run before a release publishes. The first to fail stops
# the rest, and this exits non-zero, so the release workflow never reaches its publish step. Each probe works in its
# own scratch home and builds any binary it needs itself, so all this needs is bun and the installed dependencies.
#
#   bash scripts/release-probes.sh
#
# Left out, because each needs an app the release runner doesn't have:
#   export-check.sh           hledger, to check the exported journal
#   plugin-install-check.sh   the real claude CLI
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

probe() {
  echo "== $*"
  "$@"
}

probe bun scripts/check-skill-fields.ts skills/solobooks/SKILL.md
probe bash scripts/setup-idempotent.sh
probe bash scripts/setup-no-addon.sh
probe bash scripts/doctor-negative.sh
probe bash scripts/pipe-check.sh
probe sh scripts/page-loopback-check.sh
probe bash scripts/addon-no-bun.sh
probe bash scripts/install-check.sh
probe bash scripts/npm-check.sh
echo "PASS: every release probe"
