# solobooks

Books for US solo consultants, run by the coding agent you already use. Paste one prompt into your agent, answer a few questions, and it bills your clients, records your expenses and keeps a ledger that always balances. Every invoice waits for your approval before it reaches a client, at the level you choose.

solobooks runs on your machine. It sends no email, connects to no bank, holds no passwords and has no AI inside: your agent does the talking and the outside world, and solobooks holds the math and the rules.

## Install

Paste this into your agent:

```text
Install solobooks by following https://raw.githubusercontent.com/kkeeling/solobooks/main/INSTALL.md
```

Your agent installs the app, connects itself, checks the connection, and then sets you up by asking for what an invoice needs: your business details, how clients pay you, your next invoice number, and your first client. If you'd rather do it by hand, pick your agent below.

<details>
<summary><b>Claude Code</b></summary>

Install the app, then either let it connect itself:

```sh
curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh
~/.local/bin/solobooks setup
~/.local/bin/solobooks doctor
```

or, to get updates through Claude Code, install the plugin, which carries the MCP server and the skill. Install it before running setup: setup sees the plugin and adds no second connection, and still picks your books folder.

```sh
curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh
claude plugin marketplace add kkeeling/solobooks
claude plugin install solobooks@solobooks
~/.local/bin/solobooks setup
~/.local/bin/solobooks doctor
```

Restart Claude Code so it loads the solobooks tools.

</details>

<details>
<summary><b>Codex</b> (and the ChatGPT desktop app, which shares its config)</summary>

```sh
curl -fsSL https://raw.githubusercontent.com/kkeeling/solobooks/main/install.sh | sh
~/.local/bin/solobooks setup
~/.local/bin/solobooks doctor
```

setup adds `[mcp_servers.solobooks]` to `~/.codex/config.toml` and puts the skill in `~/.agents/skills`. Restart Codex.

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Same three commands as above. setup adds solobooks to `claude_desktop_config.json`; quit and reopen Claude Desktop. Desktop doesn't read skill folders, so the tools' own descriptions guide it.

</details>

<details>
<summary><b>Any other local agent</b> (Gemini CLI, Cursor, VS Code, OpenCode, Amp, Cline, Goose, Grok Build, Muse Code, Devin CLI)</summary>

Install the app with the installer above and run `solobooks setup` to pick the books folder. Then register a stdio MCP server in your agent with the command `~/.local/bin/solobooks` and the argument `mcp`. If your agent's config expects `npx`, use `npx -y solobooks mcp` instead. Point it at the skill in `~/.agents/skills/solobooks`, which most of these agents read already.

</details>

## Supported agents

Agents that run on your machine: Claude Code, Claude Desktop, Codex, the ChatGPT desktop app, Grok Build, Meta Muse Code, Gemini CLI, Cursor, VS Code with Copilot, OpenCode, Amp, Cline, Goose and Devin CLI. solobooks is tested with Claude Code and Codex on every release.

## Not supported

Cloud-only agents can't reach books stored on your machine:
claude.ai and ChatGPT on the web and on phones, Grok on the web (unless local execution is on), Meta's Muse app, and cloud agents such as Devin's and Amp's hosted runs.

## Privacy

Your books stay on your disk, in one folder you own (`~/solobooks` unless you choose another), and solobooks never sends them anywhere.
Whatever your agent reads from them, though, goes to that agent's model vendor as part of the conversation, the same as any file you show it.

## What it does

- Clients billed hourly, by fixed-fee milestones, on a recurring retainer, or any mix, with per-client time rounding.
- Invoices numbered with no gaps, PDFs and email text ready for your agent to send, credit notes, voids, overdue reminders.
- Expenses with receipts, pass-through costs billed on to clients, and a double-entry ledger with a P&L by account.
- Past invoices brought in from a spreadsheet with their original numbers.
- An approval gate you set per action: let the agent decide, click to approve, or approve with your passkey. Claude Code asks you right in the chat; other apps, and passkeys, use the local approval page. Either way nothing happens until you approve.

US dollars, one US business, one machine.

## Add-ons

solobooks stores time; it never tracks it. Optional add-ons do that, and setup never installs one.

- **Agent time** bills the time you spent directing Claude Code and Codex, from their session logs on your machine, by a fixed rule: from each of your own messages until 10 minutes after your last action, with parallel sessions merged so no hour bills more than 60 minutes. It previews before writing anything and can't bill a day twice. In Claude Code: `claude plugin install solobooks-agent-time@solobooks`. For other agents, copy [addons/agent-time/skills/bill-agent-time](addons/agent-time/skills/bill-agent-time) into `~/.agents/skills/`.

## License

MIT. See [LICENSE](LICENSE).

solobooks is not tax or accounting advice.
It keeps records; what to claim, and what you owe, is a question for your accountant.
