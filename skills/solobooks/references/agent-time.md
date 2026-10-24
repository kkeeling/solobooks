# Billing agent time

Read this when the person wants to bill for the time they spent directing coding agents: "bill my agent time", "log my hours from my Claude sessions", "how many hours did I work for Acme this month", "track my time automatically".

solobooks stores time; it never tracks it. Counting agent time is the job of a separate add-on, **bill-agent-time**, which reads the Claude Code and Codex session logs on this machine and writes ordinary time entries through solobooks. Once written, those entries bill like any other time (see [billing.md](billing.md)).

## Is the add-on installed?

Look for its skill, `bill-agent-time`, among the skills you can load, or as a folder named `bill-agent-time` in `~/.claude/skills`, `~/.agents/skills`, or a Claude Code plugin. If you find it, load it and follow it; it has the exact commands. Don't count time yourself from the logs.

If it isn't there, tell the person what it does (the rule below) and offer to install it. Installing it is their call:

- **Claude Code:** `claude plugin install solobooks-agent-time@solobooks` (the solobooks marketplace must be added first: `claude plugin marketplace add kkeeling/solobooks`). Then restart Claude Code.
- **Any other agent:** copy the `addons/agent-time/skills/bill-agent-time` folder from https://github.com/kkeeling/solobooks into `~/.agents/skills/`.

It needs nothing else: its counter runs through `solobooks addon run`, with the runtime solobooks already carries.

## The rule, in words the person can check

- Time counts from each of the person's own actions (a message they typed, a suggestion they accepted, a slash command, an interrupt) until 10 minutes after it; the agent working alone past that counts nothing. Sessions a program started, such as `claude -p` or `codex exec`, are skipped.
- When several sessions overlap, they merge, so no clock hour bills more than 60 minutes.
- Each project folder belongs to one client (asked once, then remembered), or is marked as the person's own unbilled work. A folder nobody mapped is never billed.
- It bills finished days only, previews before writing, and writing the same day twice adds nothing.

## What to tell the person

- The hours come from the logs on their own machine; nothing is sent anywhere, and you never quote what was said in a session.
- The hours are a starting point they approve, not a claim about what the client owes. They see the preview per client per day before anything is written, and can edit any entry afterwards with `time edit`.
- If they bill a flat fee or don't bill hourly, they don't need the add-on.
