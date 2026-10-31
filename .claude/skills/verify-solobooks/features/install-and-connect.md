# Install and connect

`solobooks setup` picks the books folder, registers the MCP server with each agent app it finds, and copies the agent guide to `~/.agents/skills` and Claude Code's own skills folder. With the Claude Code plugin installed, the plugin carries the server and Claude Code's copy of the guide, so setup leaves those alone. `solobooks doctor` proves all of that works, says how to fix what doesn't, and a second setup changes nothing.

## Sub-features

- `install-setup` creates books from nothing and connects the agent it finds.
- `install-again` changes nothing on a second run.
- `install-doctor` passes on a good install and fails with a fix on a bad one.
- `install-mcp` serves every tool over stdio.

## How to get to it (user POV)

- The person's agent follows `INSTALL.md`, or the person runs `solobooks setup` then `solobooks doctor`. `solobooks setup --books <dir>` chooses another folder.
- An agent app starts `solobooks mcp` itself, once registered.
- The person installs the Claude Code plugin, or by hand registers `~/.local/bin/solobooks` with the argument `mcp`, or `npx -y solobooks mcp` if the app expects it. `control.ts` doesn't drive these routes.

## Driving it with control.ts

Preconditions:

- `control.ts up --seed empty` is ready. Its scratch home has a `.claude` folder, so it looks like a person with Claude Code. `up` already ran the first setup, as `001-setup.cli.txt`.

- **First setup.** Read `.verify/evidence/<run>/001-setup.cli.txt`. The exit is `0`, `Claude Code` has `detected` `true`, and `mcp` is `added`. Codex and Claude Desktop have `detected` `false`.
- **Second setup changes nothing.** Run `control.ts cli --as install-again -- setup`. `Claude Code` shows `"mcp": "unchanged"` and every skill folder shows `"changed": false`.
- **Doctor passes.** Run `control.ts cli --as install-doctor -- doctor`. It exits 0 with `"ok": true` and checks for `books`, `Claude Code MCP` and two `skill` folders. The `Claude Code MCP` detail ends `the server answered with all 70 tools`, or however many operations there are now.
- **MCP answers.** Run `control.ts mcp --as install-mcp --list`. It lists one tool per operation. Run `control.ts mcp --as install-mcp profile_get '{}'`. It answers with exit 0.
- **Agent configs in place.** Read the Claude Code `config` path from `001-setup.cli.txt`, and read that file. `mcpServers.solobooks.args` ends in `mcp`. Don't use `$HOME` from your own shell, which is the real home.
- **Full scratch-home check.** Run `bash scripts/setup-idempotent.sh`. It prints its own pass or fail, with three agents detected and other servers already in their configs.
- **Doctor fails with a fix.** Run `bash scripts/doctor-negative.sh`. It prints `PASS: doctor passes after setup and exits non-zero, naming the fix, when an agent's MCP entry is missing or broken`. It runs in its own scratch home, without `SOLOBOOKS_DIR`, so it also proves the server finds the books from settings alone.

## Gotchas

- Run setup and doctor through `control.ts`, never bare. A bare `solobooks setup` rewrites the person's real agent configs and settings, and it reads `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `SOLOBOOKS_DIR` and `XDG_CONFIG_HOME` from your shell. Run from this checkout, it would also point those configs at this source.
- `control.ts` sets `SOLOBOOKS_DIR`, which outranks settings, so its runs don't prove the server finds the books from settings alone. The `doctor-negative` script does.
- A damaged settings file is a known dead end: doctor and setup each name setup as the fix, and setup refuses (`billing-2kg`). Don't report that as a new failure.
- A damaged agent config is a different case. Setup exits 0 with `"mcp": "failed"` and a warning, and doctor exits 1 with `Fix <config>, then run solobooks setup.`
- `setup --books=<dir>` ignores the folder and uses the default (`billing-c4g`). Put a space before the folder.
- With the plugin installed, setup shows Claude Code with `"mcp": "plugin"` and one skill folder, and doctor reports `the solobooks plugin's server answered with all 70 tools`. That is correct, not a failed registration.
- In a home with no agent folder or `.claude.json`, doctor exits 1 with `No agent app was found`, while setup exits 0 with a warning. That's correct, so don't weaken a run to get past it.
- Doctor warns `No backup folder is chosen` on every fresh run. That warning doesn't fail it.
- `control.ts` runs the source, so this feature doesn't prove the released binary, `install.sh` or the Claude Code plugin. The nearest proofs all build from this checkout, not a published release: `scripts/install-check.sh` (a loopback mirror and a scratch home), `scripts/npm-check.sh` (local tarballs and a dead registry, but your real `HOME`), and `scripts/plugin-install-check.sh` (the real `claude` CLI in a scratch home, so run it from a normal terminal, not inside a Claude Code session). `SOLOBOOKS_BIN=<built binary> bash scripts/setup-idempotent.sh`, and the same for `doctor-negative.sh`, runs those checks on a compiled binary. This map hasn't run any of these.
- A real agent app isn't driven here. `control.ts mcp` speaks the same protocol, but report "a real agent session used it" as not verified unless one did.
