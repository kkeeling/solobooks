#!/bin/sh
# An agent that follows the served INSTALL.md literally: fetches it with curl, then runs its shell blocks in order
# with sh. $1 is the prompt, which carries the address of INSTALL.md on the loopback mirror.
set -eu
url=$(printf '%s' "$1" | grep -o 'http://127.0.0.1:[0-9]*/INSTALL.md' | head -n 1)
[ -n "$url" ] || { echo "no INSTALL.md address in the prompt" >&2; exit 1; }
# A real Claude Code has made its own folder in HOME by the time it runs commands.
mkdir -p "$HOME/.claude"
curl -fsSL "$url" > "$HOME/INSTALL.md"
awk '/^```sh$/ { on = 1; next } /^```$/ { on = 0; next } on' "$HOME/INSTALL.md" > "$HOME/install-steps.sh"
[ -s "$HOME/install-steps.sh" ] || { echo "INSTALL.md has no sh blocks" >&2; exit 1; }
sh -e "$HOME/install-steps.sh"
