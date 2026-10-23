#!/bin/sh
# Starts the solobooks MCP server for the Claude Code plugin. The plugin carries the connection and the skill; the
# solobooks binary itself comes from the installer, so this finds it and hands over.
set -eu
for bin in "${SOLOBOOKS_BIN:-}" "$HOME/.local/bin/solobooks" "$(command -v solobooks 2> /dev/null || true)"; do
  if [ -n "$bin" ] && [ -x "$bin" ]; then exec "$bin" mcp "$@"; fi
done
echo "solobooks isn't installed. Install it with: curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh" >&2
exit 1
