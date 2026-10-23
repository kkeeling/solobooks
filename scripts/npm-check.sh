#!/usr/bin/env bash
# ISC-88: the npm wrapper, packed and installed from local tarballs, runs the compiled binary: `bunx solobooks
# --version` prints the version, and the same command serves MCP over stdio. The registry is pointed at a dead
# address, so nothing comes from the network, and nothing is published.
#
#   bash scripts/npm-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "run this on macOS or Linux" ;; esac
case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; *) arch=x64 ;; esac
VERSION="$("$BUN" -e 'console.log((await import(process.argv[1])).VERSION)' "$ROOT/src/version.ts")"

SOLOBOOKS_TARGETS="$os-$arch" SOLOBOOKS_OUT="$W/release" sh "$ROOT/scripts/build-release.sh" > /dev/null
"$BUN" "$ROOT/scripts/build-npm.ts" "$W/release" "$W/npm"
(cd "$W/npm/solobooks" && "$BUN" pm pack --quiet --destination "$W")
(cd "$W/npm/solobooks-$os-$arch" && "$BUN" pm pack --quiet --destination "$W")

mkdir -p "$W/project"
cat > "$W/project/package.json" << JSON
{
  "name": "npm-check",
  "private": true,
  "dependencies": { "solobooks": "file:$W/solobooks-$VERSION.tgz" },
  "overrides": { "@solobooks/$os-$arch": "file:$W/solobooks-$os-$arch-$VERSION.tgz" }
}
JSON
# The other platforms' packages aren't built here; npm skips optional packages for other machines, and so does bun.
(cd "$W/project" && BUN_CONFIG_REGISTRY=http://127.0.0.1:9/ "$BUN" install > "$W/install.log" 2>&1) || { cat "$W/install.log"; fail "bun install"; }

got="$(cd "$W/project" && "$BUN" x solobooks --version)"
[ "$got" = "solobooks $VERSION" ] || fail "bunx solobooks --version printed '$got'"
echo "$got"

# The wrapper is what an agent's npx config runs, so it must carry MCP over stdio too.
mkdir -p "$W/books"
(cd "$W/project" && SOLOBOOKS_DIR="$W/books" "$BUN" -e '
  const { handshake } = await import(process.argv[1]);
  const r = await handshake([`${process.cwd()}/node_modules/.bin/solobooks`, "mcp"], process.env);
  if ("error" in r) { console.error("FAIL: MCP through the wrapper: " + r.error); process.exit(1); }
  console.log(`MCP through the wrapper: ${r.tools.length} tools`);
' "$ROOT/src/doctor.ts")

echo "PASS: the npm wrapper from packed tarballs runs the compiled binary, for --version and for MCP"
