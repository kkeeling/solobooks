#!/usr/bin/env bash
# ISC-83: the one-line installer, run in a bare environment with no bun or Node on PATH and a fresh HOME, downloads
# this machine's binary from a loopback mirror of a local release build, checks its checksum, and leaves a working
# ~/.local/bin/solobooks. Then a tampered mirror must install nothing. Starts and stops its own mirror.
#
#   bash scripts/install-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
WORK="$(mktemp -d)"
MIRROR="$WORK/mirror"
SERVER_PID=""
cleanup() { if [ -n "$SERVER_PID" ]; then { kill "$SERVER_PID"; wait "$SERVER_PID"; } 2> /dev/null || true; fi; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "run this on macOS or Linux" ;; esac
case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; *) arch=x64 ;; esac

# A release build for this machine, plus the installer, served from 127.0.0.1.
SOLOBOOKS_TARGETS="$os-$arch" SOLOBOOKS_OUT="$MIRROR" sh "$ROOT/scripts/build-release.sh" > "$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; fail "build"; }
cp "$ROOT/install.sh" "$MIRROR/install.sh"
"$BUN" -e '
  const [dir, portFile] = process.argv.slice(1);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (!/^[\w.-]+$/.test(name)) return new Response("not found", { status: 404 });
      const f = Bun.file(`${dir}/${name}`);
      return f.size ? new Response(f) : new Response("not found", { status: 404 });
    },
  });
  await Bun.write(portFile, String(server.port));
' "$MIRROR" "$WORK/port" &
SERVER_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
[ -s "$WORK/port" ] || fail "the loopback mirror didn't start"
BASE="http://127.0.0.1:$(cat "$WORK/port")"

# The probe: a bare environment, a fresh HOME, and nothing but /usr/bin and /bin on PATH.
H="$WORK/home"
mkdir -p "$H"
env -i HOME="$H" PATH=/usr/bin:/bin SOLOBOOKS_DOWNLOAD_BASE="$BASE" sh -c '
  if command -v bun > /dev/null || command -v node > /dev/null; then echo "bun or node is on PATH" >&2; exit 1; fi
  curl -fsSL "$SOLOBOOKS_DOWNLOAD_BASE/install.sh" | sh && ~/.local/bin/solobooks --version
' > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; fail "the installer didn't leave a working binary"; }
cat "$WORK/install.log"
want="solobooks $("$BUN" -e 'console.log((await import(process.argv[1])).VERSION)' "$ROOT/src/version.ts")"
[ "$(tail -n 1 "$WORK/install.log")" = "$want" ] || fail "~/.local/bin/solobooks --version didn't print $want"
grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$WORK/install.log" || fail "the installer didn't print the PATH line to add"

# A mirror whose binary doesn't match its checksum installs nothing.
H2="$WORK/home2"
mkdir -p "$H2"
printf 'tampered' >> "$MIRROR/solobooks-$os-$arch"
if env -i HOME="$H2" PATH=/usr/bin:/bin SOLOBOOKS_DOWNLOAD_BASE="$BASE" sh -c 'curl -fsSL "$SOLOBOOKS_DOWNLOAD_BASE/install.sh" | sh' > "$WORK/tampered.log" 2>&1; then
  cat "$WORK/tampered.log"
  fail "the installer accepted a binary that doesn't match SHA256SUMS"
fi
grep -q "doesn't match its checksum" "$WORK/tampered.log" || { cat "$WORK/tampered.log"; fail "the installer didn't say the checksum failed"; }
[ -z "$(ls -A "$H2/.local/bin" 2> /dev/null)" ] || fail "a tampered download left files in ~/.local/bin"

echo "PASS: installed $want with no bun or Node on PATH, and refused a tampered binary"
