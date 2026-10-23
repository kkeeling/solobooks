#!/usr/bin/env bash
# ISC-100: the agent-time counter runs through the compiled solobooks binary with no bun on PATH. Builds the binary for
# this machine, copies the add-on's skill into a scratch HOME the way an install would (away from this repo and its
# node_modules), writes synthetic session logs there, and runs the counter under a bare environment.
#
#   bash scripts/addon-no-bun.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "run this on macOS or Linux" ;; esac
case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; *) arch=x64 ;; esac
SOLOBOOKS_TARGETS="$os-$arch" SOLOBOOKS_OUT="$H/build" sh "$ROOT/scripts/build-release.sh" > /dev/null
mkdir -p "$H/bin"
cp "$H/build/solobooks-$os-$arch" "$H/bin/solobooks"

# The skill as installed, outside the repo.
mkdir -p "$H/.claude/skills"
cp -R "$ROOT/addons/agent-time/skills/bill-agent-time" "$H/.claude/skills/"
SCRIPT="$H/.claude/skills/bill-agent-time/scripts/count-time.ts"

# Synthetic logs: a Claude Code session in Acme's folder and a Codex session in Beta's, on 2026-10-05 (UTC).
"$BUN" -e '
  const s = await import(process.argv[1] + "/addons/agent-time/test/support/logs.ts");
  const h = process.argv[2];
  s.put(s.claudeFile(h, "-work-acme", "s1"), s.claudeLines("s1", "/work/acme", [[540, "typed"], [541, "assistant"], [548, "typed"], [600, "tool"]]));
  s.put(s.codexFile(h, "c1"), s.codexLines("c1", "/work/beta", [[700, "user_message"], [705, "agent"]]));
' "$ROOT" "$H"

bare() { env -i HOME="$H" PATH=/usr/bin:/bin SOLOBOOKS_NOW=2026-10-22T12:00:00.000Z "$@"; }
if bare /bin/sh -c 'command -v bun node' > /dev/null; then fail "bun or node is on the bare PATH, so this proves nothing"; fi

# Runs the compiled solobooks bare, saving its output under a name; on failure, shows that output.
sb() {
  local out="$H/$1.json"
  shift
  bare "$H/bin/solobooks" "$@" --books "$H/books" > "$out" 2>&1 || fail "solobooks $* exited $?: $(cat "$out")"
}
sb client-1 client add --name Acme --source person
sb client-2 client add --name Beta --source person
sb map-1 addon run "$SCRIPT" map --folder /work/acme --client-id 1 --timezone UTC
sb map-2 addon run "$SCRIPT" map --folder /work/beta --client-id 2

echo "== solobooks addon run count-time.ts preview, no bun on PATH"
sb preview addon run "$SCRIPT" preview --from 2026-10-05 --to 2026-10-05
sb write-1 addon run "$SCRIPT" write --from 2026-10-05 --to 2026-10-05
sb write-2 addon run "$SCRIPT" write --from 2026-10-05 --to 2026-10-05
sb time time list

"$BUN" -e '
  const h = process.argv[1];
  const read = async (f) => JSON.parse(await Bun.file(`${h}/${f}`).text());
  const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
  const p = await read("preview.json");
  const hours = p.per_client_day.map((d) => `${d.client} ${d.date} ${d.hours} h`).join(", ");
  console.log(`hours: ${hours}; total ${p.total_hours} h`);
  // Acme 9:00-9:18 (two messages 8 minutes apart, then the cap); Beta 11:40-11:50.
  if (hours !== "Acme 2026-10-05 0.3 h, Beta 2026-10-05 0.17 h") fail("unexpected hours: " + hours);
  const one = (await read("write-1.json")).written.map((w) => w.status).join(" ");
  const two = (await read("write-2.json")).written.map((w) => w.status).join(" ");
  if (one !== "added added") fail("first write: " + one);
  if (two !== "already written already written") fail("second write: " + two);
  const t = (await read("time.json")).time_entries.map((e) => `${e.client_id}:${e.minutes}:${e.source}`).join(" ");
  if (t !== "1:18:agent-time: claude/s1 2:10:agent-time: codex/c1") fail("time entries: " + t);
' "$H"
echo "PASS: the compiled solobooks ran the agent-time counter with no bun or node on PATH, wrote 2 entries once, and a re-run added none"
