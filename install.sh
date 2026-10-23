#!/bin/sh
# Installs solobooks on macOS or Linux: downloads the binary for this machine, checks it against the release's
# SHA256SUMS, and puts it at ~/.local/bin/solobooks. Needs only curl and a sha256 tool; no bun, no Node.
#
#   curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh
#
# SOLOBOOKS_VERSION=0.1.0 installs that version instead of the latest. SOLOBOOKS_DOWNLOAD_BASE points at another
# copy of the release files (https, or http on this machine only).
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'solobooks install: %s\n' "$*" >&2; exit 1; }

if [ -n "${SOLOBOOKS_DOWNLOAD_BASE:-}" ]; then
  BASE=${SOLOBOOKS_DOWNLOAD_BASE%/}
elif [ -n "${SOLOBOOKS_VERSION:-}" ]; then
  BASE="https://github.com/kkeeling/solobooks/releases/download/v${SOLOBOOKS_VERSION#v}"
else
  BASE="https://github.com/kkeeling/solobooks/releases/latest/download"
fi
# The checksums come from the same place as the binary, so the place itself has to be trusted.
case "$BASE" in
  https://*) ;;
  http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) ;;
  *) die "SOLOBOOKS_DOWNLOAD_BASE must be an https:// address, or http:// on 127.0.0.1 or localhost." ;;
esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "this installer is for macOS and Linux; on Windows, download solobooks-windows-x64.exe from the release page." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "there is no solobooks build for $(uname -m)." ;;
esac
# An arm64 Mac running this shell under Rosetta still wants the arm64 build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="solobooks-$os-$arch"

if command -v sha256sum > /dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum > /dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "it needs sha256sum or shasum to check the download, and found neither."
fi
command -v curl > /dev/null 2>&1 || die "it needs curl."

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
tmp=$(mktemp "$BIN_DIR/.solobooks.XXXXXX")
sums=$(mktemp "${TMPDIR:-/tmp}/solobooks-sums.XXXXXX")
trap 'rm -f "$tmp" "$sums"' EXIT

say "Downloading $asset from $BASE"
curl -fsSL --proto '=https,http' -o "$tmp" "$BASE/$asset" || die "couldn't download $BASE/$asset."
curl -fsSL --proto '=https,http' -o "$sums" "$BASE/SHA256SUMS" || die "couldn't download $BASE/SHA256SUMS."

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$sums")
[ -n "$want" ] || die "SHA256SUMS has no line for $asset."
got=$(sha "$tmp")
[ "$got" = "$want" ] || die "the download doesn't match its checksum (got $got, expected $want), so nothing was installed."

chmod 755 "$tmp"
"$tmp" --version > /dev/null 2>&1 || die "the downloaded binary doesn't run on this machine, so nothing was installed."
mv -f "$tmp" "$BIN_DIR/solobooks"
trap 'rm -f "$sums"' EXIT

say "Installed $("$BIN_DIR/solobooks" --version) at $BIN_DIR/solobooks"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    # The startup file is named for the person to read, so its ~ stays as written.
    # shellcheck disable=SC2088
    case "${SHELL:-}" in
      */zsh) rc="~/.zshrc" ;;
      */bash) if [ "$os" = darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi ;;
      *) rc="your shell's startup file" ;;
    esac
    say ""
    say "$BIN_DIR isn't on your PATH. Add this line to $rc, then open a new terminal:"
    say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
say ""
say "Next: $BIN_DIR/solobooks setup"
