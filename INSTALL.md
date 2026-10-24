# Installing solobooks

These are the steps for an agent installing solobooks 0.1.2 for the person it works for. Follow them in order, run each command yourself, and tell the person what happened in plain words. Each step ends with a check; don't move on until it passes.

solobooks runs on macOS and Linux this way. On Windows, stop and tell the person the one-line installer doesn't support Windows yet; they can download `solobooks-windows-x64.exe` from https://github.com/kkeeling/solobooks/releases/latest and you can continue from step 2 with that file.

## 1. Install the app

```sh
curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh
```

It downloads the solobooks binary for this machine, checks it against the release's checksums, and puts it at `~/.local/bin/solobooks`. Nothing else gets installed.

Check: `~/.local/bin/solobooks --version` prints `solobooks 0.1.2` or later. If the installer said `~/.local/bin` isn't on the PATH, pass that line on to the person; meanwhile use the full path `~/.local/bin/solobooks` in every command below.

## 2. Connect it

setup writes to the agent apps' own config folders (and `~/.agents/skills`), so if this app runs commands in a sandbox, ask the person to approve running setup outside it.

```sh
~/.local/bin/solobooks setup
```

This registers solobooks' MCP server with every agent app it finds here (Claude Code, Codex, Claude Desktop), copies the solobooks skill into the folders agents read (`~/.agents/skills`, and Claude Code's own skills folder), and creates the books folder, `~/solobooks` by default. It is safe to run again.

Check: the output's `warnings` list is empty. If it warns that the books folder is inside iCloud, Dropbox, OneDrive or Google Drive, ask the person where else they'd like their books, and run `~/.local/bin/solobooks setup --books <that folder>`. If your own agent app isn't in the output's `agents` list as detected, register a stdio MCP server yourself with the command `~/.local/bin/solobooks` and the argument `mcp`.

## 3. Check it

```sh
~/.local/bin/solobooks doctor
```

Check: it prints `"ok": true` and exits 0. If not, each failed check has a `fix`; do what it says and run doctor again. Don't continue past a failing doctor.

## 4. Load the tools

Agent apps load MCP servers when they start, so the person may need to restart this app once to see the solobooks tools. Tell them so. Until then, everything works through the CLI: `~/.local/bin/solobooks help` lists every command.

## 5. Start onboarding

Read the solobooks skill (`~/.agents/skills/solobooks/SKILL.md`; Claude Code has the same file in its own skills folder), then follow its `references/onboarding.md`. It takes the person from here to their first draft invoice by asking for five things. Ask; don't assume.

Two rules from the skill that matter from the first minute: when solobooks answers `"status": "pending"`, nothing has happened yet and the person must approve it; and solobooks is not tax or accounting advice, so never present it as such.
