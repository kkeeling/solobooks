#!/usr/bin/env bash
# ISC-85: running `solobooks setup` twice leaves every agent config byte-identical to one run, and leaves the other
# entries already in those configs alone. Runs in a fresh scratch HOME with a bare environment, so it never touches
# this machine's real agent configs.
#
#   bash scripts/setup-idempotent.sh            # runs the source with bun
#   SOLOBOOKS_BIN=/path/to/solobooks bash scripts/setup-idempotent.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SOLOBOOKS_BIN:-}" ]; then BIN=("$SOLOBOOKS_BIN"); else BIN=("$(command -v bun)" "$ROOT/src/cli.ts"); fi
H="$(mktemp -d)"
# Where Claude Desktop keeps its config on this OS.
if [ "$(uname -s)" = Darwin ]; then DESKTOP="Library/Application Support/Claude"; else DESKTOP=".config/Claude"; fi
trap 'rm -rf "$H"' EXIT

# Agents that look installed, each with a config that already holds someone else's server.
mkdir -p "$H/.claude" "$H/.codex" "$H/$DESKTOP"
printf '{\n  "numStartups": 3,\n  "mcpServers": {\n    "other": {\n      "command": "other"\n    }\n  }\n}\n' > "$H/.claude.json"
printf 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["serve"]\n\n[profiles.fast]\nmodel = "mini"\n' > "$H/.codex/config.toml"
printf '{"mcpServers":{"other":{"command":"other"}}}' > "$H/$DESKTOP/claude_desktop_config.json"

setup() { env -i HOME="$H" PATH=/usr/bin:/bin "${BIN[@]}" setup > "$H/setup-$1.json"; }
snapshot() {
  (cd "$H" && find .claude.json .codex .claude .agents .config "$DESKTOP" -type f -print0 \
    | sort -z | xargs -0 shasum -a 256)
}

setup 1
snapshot > "$H/after-1.txt"
setup 2
snapshot > "$H/after-2.txt"

if ! diff -u "$H/after-1.txt" "$H/after-2.txt"; then
  echo "FAIL: a second solobooks setup changed the files above" >&2
  exit 1
fi

# The first run connected every agent and copied the skill; the second found nothing to change.
check() {
  "$(command -v bun)" -e '
    const [h, desktopDir] = [process.argv[1], process.argv[2]];
    const one = JSON.parse(await Bun.file(`${h}/setup-1.json`).text());
    const two = JSON.parse(await Bun.file(`${h}/setup-2.json`).text());
    const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
    const mcp = (r) => r.agents.filter((a) => a.detected).map((a) => a.agent + "=" + a.mcp).join(" ");
    if (mcp(one) !== "Claude Code=added Codex=added Claude Desktop=added") fail("first run: " + mcp(one));
    if (mcp(two) !== "Claude Code=unchanged Codex=unchanged Claude Desktop=unchanged") fail("second run: " + mcp(two));
    if (two.skills.some((s) => s.changed)) fail("second run rewrote a skill file");
    const claude = JSON.parse(await Bun.file(`${h}/.claude.json`).text());
    const desktop = JSON.parse(await Bun.file(`${h}/${desktopDir}/claude_desktop_config.json`).text());
    const codex = Bun.TOML.parse(await Bun.file(`${h}/.codex/config.toml`).text());
    if (claude.numStartups !== 3 || claude.mcpServers.other?.command !== "other" || !claude.mcpServers.solobooks) fail("Claude Code config lost an entry");
    if (desktop.mcpServers.other?.command !== "other" || !desktop.mcpServers.solobooks) fail("Claude Desktop config lost an entry");
    if (codex.model !== "o3" || codex.mcp_servers.other?.command !== "other" || codex.profiles?.fast?.model !== "mini" || !codex.mcp_servers.solobooks) fail("Codex config lost an entry");
    if (!(await Bun.file(`${one.books}/solobooks.sqlite`).exists())) fail("no books file in " + one.books);
  ' "$H" "$DESKTOP"
}
check
echo "PASS: setup twice leaves $(wc -l < "$H/after-2.txt" | tr -d ' ') agent and skill files byte-identical, other entries intact"
