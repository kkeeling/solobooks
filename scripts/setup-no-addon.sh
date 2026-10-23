#!/usr/bin/env bash
# ISC-101: `solobooks setup` never installs the agent-time add-on unless asked. Runs setup in a fresh scratch HOME where
# Claude Code, Codex and Claude Desktop all look installed, then checks that no add-on file, skill or plugin entry, and
# no mention of it, landed anywhere in that home or in setup's output.
#
#   bash scripts/setup-no-addon.sh
#   SOLOBOOKS_BIN=/path/to/solobooks bash scripts/setup-no-addon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SOLOBOOKS_BIN:-}" ]; then BIN=("$SOLOBOOKS_BIN"); else BIN=("$(command -v bun)" "$ROOT/src/cli.ts"); fi
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
if [ "$(uname -s)" = Darwin ]; then DESKTOP="Library/Application Support/Claude"; else DESKTOP=".config/Claude"; fi

mkdir -p "$H/.claude" "$H/.codex" "$H/$DESKTOP"
env -i HOME="$H" PATH=/usr/bin:/bin "${BIN[@]}" setup > "$H/setup.json"

# Setup did its own job, so an empty home can't pass this by accident.
grep -q '"mcp": "added"' "$H/setup.json" || fail "setup connected no agent; see $H/setup.json"
[ -f "$H/.claude/skills/solobooks/SKILL.md" ] || fail "setup didn't copy the solobooks skill"

# Nothing from the add-on: none of its files, under any name it ships with.
found="$(cd "$H" && find . \( -name 'bill-agent-time' -o -name 'count-time.ts' -o -name 'billing-rule.md' -o -name 'agent-time*' -o -name '*agent-time*' \) -print)"
[ -z "$found" ] || fail "setup installed add-on files: $found"
# And no mention of it in any file setup wrote or printed, such as a plugin entry in an agent config.
mentions="$(grep -rIl -e 'agent-time' "$H" 2> /dev/null || true)"
[ -z "$mentions" ] || fail "setup mentions the add-on in: $mentions"
echo "PASS: setup connected $(grep -c '"mcp": "added"' "$H/setup.json") agents and installed no add-on: no add-on files, skill, plugin entry or mention in the home"
