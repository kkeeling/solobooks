#!/usr/bin/env bash
# ISC-86: `solobooks doctor` passes on a fresh setup, then fails, saying how to fix it, once a detected agent loses
# its solobooks MCP entry. Runs in a fresh scratch HOME with a bare environment, never against real agent configs.
#
#   bash scripts/doctor-negative.sh            # runs the source with bun
#   SOLOBOOKS_BIN=/path/to/solobooks bash scripts/doctor-negative.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
if [ -n "${SOLOBOOKS_BIN:-}" ]; then BIN=("$SOLOBOOKS_BIN"); else BIN=("$BUN" "$ROOT/src/cli.ts"); fi
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
mkdir -p "$H/.claude" "$H/.codex"

sb() { env -i HOME="$H" PATH=/usr/bin:/bin "${BIN[@]}" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# The doctor report in $1 fails exactly one check, named $2, with $3 in its detail and setup as its fix.
only_failure() {
  "$BUN" -e '
    const [file, name, says] = process.argv.slice(1);
    const r = JSON.parse(await Bun.file(file).text());
    const bad = r.checks.filter((c) => !c.ok);
    const ok = r.ok === false && bad.length === 1 && bad[0].check === name && bad[0].detail.includes(says) && bad[0].fix === "Run solobooks setup.";
    if (!ok) { console.error("FAIL: expected only " + name + " to fail (" + says + "), got " + JSON.stringify(bad)); process.exit(1); }
  ' "$1" "$2" "$3"
}

sb setup > /dev/null
sb doctor > "$H/doctor-ok.json" || fail "doctor failed right after setup: $(cat "$H/doctor-ok.json")"

# Remove solobooks from Claude Code's config, keeping everything else in it.
"$BUN" -e 'const f = process.argv[1]; const c = JSON.parse(await Bun.file(f).text()); delete c.mcpServers.solobooks; await Bun.write(f, JSON.stringify(c, null, 2));' "$H/.claude.json"
set +e; sb doctor > "$H/doctor-claude.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor exited 0 with Claude Code's MCP entry removed"
only_failure "$H/doctor-claude.json" "Claude Code MCP" "has no solobooks MCP server"

# Setup repairs it; then break Codex's entry the same way.
sb setup > /dev/null
sb doctor > /dev/null || fail "doctor still failed after setup repaired Claude Code"
"$BUN" -e 'const f = process.argv[1]; const t = await Bun.file(f).text(); await Bun.write(f, t.replace(/^\[mcp_servers\.solobooks\]\n(?:(?!\[).*\n?)*/m, ""));' "$H/.codex/config.toml"
set +e; sb doctor > "$H/doctor-codex.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor exited 0 with Codex's MCP entry removed"
only_failure "$H/doctor-codex.json" "Codex MCP" "has no solobooks MCP server"

# A registered command that isn't a working MCP server fails too: the handshake is real.
sb setup > /dev/null # repairs Codex
"$BUN" -e 'const f = process.argv[1]; const c = JSON.parse(await Bun.file(f).text()); c.mcpServers.solobooks = { type: "stdio", command: "/bin/cat", args: [], env: {} }; await Bun.write(f, JSON.stringify(c, null, 2));' "$H/.claude.json"
set +e; sb doctor > "$H/doctor-cat.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor exited 0 with a registered command that isn't an MCP server"
only_failure "$H/doctor-cat.json" "Claude Code MCP" "doesn't work"

echo "PASS: doctor passes after setup and exits non-zero, naming the fix, when an agent's MCP entry is missing or broken"
