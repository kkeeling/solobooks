#!/bin/sh
# Builds the release binaries with bun build --compile, one per platform, plus SHA256SUMS. Each binary carries its
# own runtime, so the person installs nothing else.
#
#   sh scripts/build-release.sh                              # every platform, into dist/release
#   SOLOBOOKS_TARGETS="darwin-arm64" sh scripts/build-release.sh
#   SOLOBOOKS_OUT=/some/dir sh scripts/build-release.sh
#
# Building for a platform other than this one downloads that platform's bun runtime once.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TARGETS=${SOLOBOOKS_TARGETS:-"darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64"}
OUT=${SOLOBOOKS_OUT:-dist/release}
VERSION=$(bun -e 'console.log((await import("./src/version.ts")).VERSION)')

rm -rf "$OUT"
mkdir -p "$OUT"
for t in $TARGETS; do
  case "$t" in
    darwin-arm64 | linux-arm64) target="bun-$t" ;;
    # The baseline x64 builds run on CPUs without AVX2 too.
    darwin-x64 | linux-x64 | windows-x64) target="bun-$t-baseline" ;;
    *) echo "unknown target: $t" >&2; exit 1 ;;
  esac
  ext=""
  [ "$t" = windows-x64 ] && ext=".exe"
  bun build --compile --target="$target" src/cli.ts --outfile "$OUT/solobooks-$t$ext"
  # macOS refuses to run an unsigned arm64 binary; an ad-hoc signature is enough when it arrives through curl.
  case "$t" in
    darwin-*) if command -v codesign > /dev/null 2>&1; then codesign --force --sign - "$OUT/solobooks-$t"; fi ;;
  esac
done

cd "$OUT"
if command -v sha256sum > /dev/null 2>&1; then sha256sum solobooks-* > SHA256SUMS; else shasum -a 256 solobooks-* > SHA256SUMS; fi
echo "solobooks $VERSION:"
cat SHA256SUMS
