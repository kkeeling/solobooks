#!/usr/bin/env bash
# ISC-87: in a fresh HOME, `claude plugin install` from this repo's marketplace installs the solobooks MCP server
# and skill, and the server answers. Uses the real claude CLI, so run it from a normal terminal, not from inside a
# Claude Code session.
#
#   bash scripts/plugin-install-check.sh
#   CLAUDE_BIN=/path/to/claude bash scripts/plugin-install-check.sh
#
# The marketplace is this checkout, so it tests what is here now, pushed or not.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || true)}"
[ -x "$CLAUDE" ] || { echo "FAIL: no claude CLI found; set CLAUDE_BIN" >&2; exit 1; }
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# The plugin finds the solobooks binary at ~/.local/bin, where the installer puts it.
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "run this on macOS or Linux" ;; esac
case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; *) arch=x64 ;; esac
SOLOBOOKS_TARGETS="$os-$arch" SOLOBOOKS_OUT="$H/build" sh "$ROOT/scripts/build-release.sh" > /dev/null
mkdir -p "$H/.local/bin"
cp "$H/build/solobooks-$os-$arch" "$H/.local/bin/solobooks"
env -i HOME="$H" PATH=/usr/bin:/bin "$H/.local/bin/solobooks" setup --books "$H/books" > /dev/null # books only: no agent dirs yet

cl() { env -i HOME="$H" PATH="$(dirname "$CLAUDE"):/usr/bin:/bin" TERM=dumb "$CLAUDE" "$@"; }

echo "== claude plugin validate"
cl plugin validate "$ROOT"
echo "== claude plugin marketplace add"
cl plugin marketplace add "$ROOT"
echo "== claude plugin install"
cl plugin install solobooks@solobooks --scope user
echo "== claude plugin list"
cl plugin list | tee "$H/plugins.txt"
grep -qi "solobooks" "$H/plugins.txt" || fail "claude plugin list doesn't show solobooks"

skill="$(find "$H/.claude/plugins" -path '*/skills/solobooks/SKILL.md' -print -quit)"
[ -n "$skill" ] || fail "no solobooks skill under ~/.claude/plugins"
echo "skill: $skill"

echo "== claude mcp list"
cl mcp list | tee "$H/mcp.txt"
grep -i "solobooks" "$H/mcp.txt" | grep -qi "connected" || fail "claude mcp list doesn't show the solobooks server connected"

echo "PASS: claude plugin install put the solobooks MCP server and skill in place, and the server connected"
