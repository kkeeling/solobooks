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

# ISC-155: everything above ran with no SOLOBOOKS_DIR and no --books, so each passing doctor proved a registered server
# finds the books from the settings alone. Now the settings point at the wrong folder while doctor looks at the good
# books with --books. The servers can't reach them, and doctor has to say so.
sb setup > /dev/null # repairs Claude Code
SETTINGS="$H/.config/solobooks/config.json"
GOOD="$H/solobooks"
record() { "$BUN" -e 'const [f, books] = process.argv.slice(1); const c = JSON.parse(await Bun.file(f).text()); c.books = books; await Bun.write(f, JSON.stringify(c, null, 2));' "$SETTINGS" "$1"; }
# The report in $1 passes the books check, and fails each agent's MCP check, saying $2, with setup --books as its fix.
mcp_failures() {
  "$BUN" -e '
    const [file, says] = process.argv.slice(1);
    const r = JSON.parse(await Bun.file(file).text());
    const bad = r.checks.filter((c) => !c.ok);
    const mcp = bad.filter((c) => c.check.endsWith(" MCP"));
    const ok = r.ok === false && r.checks.find((c) => c.check === "books").ok === true && mcp.length === 2
      && mcp.every((c) => c.detail.includes(says) && c.fix.includes("solobooks setup --books"));
    if (!ok) { console.error("FAIL: expected both MCP checks to fail (" + says + "), got " + JSON.stringify(bad)); process.exit(1); }
  ' "$1" "$2"
}
record "$H/nowhere"
set +e; sb doctor --books "$GOOD" > "$H/doctor-lost.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor --books exited 0 with servers that can't reach the books"
mcp_failures "$H/doctor-lost.json" "There are no books"

# When doctor's own books check fails too, the person gets one fix: only books fails.
set +e; sb doctor > "$H/doctor-books.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor exited 0 with the recorded folder empty"
"$BUN" -e '
  const r = JSON.parse(await Bun.file(process.argv[1]).text());
  const bad = r.checks.filter((c) => !c.ok);
  if (bad.length !== 1 || bad[0].check !== "books") { console.error("FAIL: expected only books to fail, got " + JSON.stringify(bad)); process.exit(1); }
' "$H/doctor-books.json"

# Damaged settings with --books: the settings check and both servers fail, and the fix each names really works.
printf '{ not json' > "$SETTINGS"
set +e; sb doctor --books "$GOOD" > "$H/doctor-damaged.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor --books exited 0 with damaged settings"
mcp_failures "$H/doctor-damaged.json" "isn't valid JSON"
sb setup --books "$GOOD" > /dev/null
# Settings right again, with no flag and no variable: the servers reach the books on their own.
sb doctor > "$H/doctor-found.json" || fail "doctor failed with the settings right: $(cat "$H/doctor-found.json")"
echo "PASS: doctor fails the MCP check when a registered server can't reach the books, and passes once it finds them from the settings alone"

# ISC-170: real books in both folders, so the server answers happily, but from the wrong one.
sb setup --books "$H/other" > /dev/null
set +e; sb doctor --books "$GOOD" > "$H/doctor-other.json"; code=$?; set -e
[ "$code" -ne 0 ] || fail "doctor --books exited 0 with servers using other books"
mcp_failures "$H/doctor-other.json" "it uses the books in"
sb setup --books "$GOOD" > /dev/null
sb doctor --books "$GOOD" > "$H/doctor-same.json" || fail "doctor --books failed with the settings naming that folder: $(cat "$H/doctor-same.json")"
echo "PASS: doctor fails the MCP check when a registered server would use other books than the ones it checked"

echo "PASS: doctor passes after setup and exits non-zero, naming the fix, when an agent's MCP entry is missing or broken"
