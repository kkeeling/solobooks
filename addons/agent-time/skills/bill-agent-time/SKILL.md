---
name: bill-agent-time
description: Use when the person says "bill my agent time", "bill my time for Acme", "log my October hours", "how many hours did I work for a client", "count my hours from my sessions", "turn my Claude Code or Codex sessions into hours", "fill in my timesheet", "time tracking", "which folders belong to which client", or asks why the counter gave the hours it did. Counts the time a consultant spent directing Claude Code and Codex from the session logs on this machine (a 10-minute idle cap, and at most 60 minutes per clock hour across all clients), maps project folders to clients once, previews the entries, then writes them to solobooks as time entries.
license: MIT
compatibility: Needs the solobooks app (check with `solobooks doctor`). Reads Claude Code logs in ~/.claude/projects and Codex logs in ~/.codex/sessions. Runs through `solobooks addon run`, so nothing else needs installing.
metadata:
  version: "0.1.2"
---

# Bill agent time

This add-on counts the time the person spent directing coding agents and writes it into solobooks as ordinary time entries. The counter is plain code: the same logs always give the same hours, and [references/billing-rule.md](references/billing-rule.md) says the rule in words. Read it before you explain any number.

## How to run it

The counter is `scripts/count-time.ts` in this skill's folder. Run it through solobooks, never with bun or node:

```
solobooks addon run <this skill's folder>/scripts/count-time.ts <command> [flags]
```

| Command | What it does |
|---|---|
| `preview --from YYYY-MM-DD --to YYYY-MM-DD` | Counts the period and changes nothing. |
| `map --folder <dir> --client-id <id> [--engagement-id <id>]` | Records that a project folder's work belongs to a client. The first map also records the person's time zone (this machine's, or `--timezone America/New_York`). |
| `map --folder <dir> --not-billed` | Records that a folder is the person's own work, so it stops coming up. |
| `write --from YYYY-MM-DD --to YYYY-MM-DD` | Writes the entries through `solobooks time add`. Add `--dry-run` to check first. |

Add `--books <dir>` when solobooks needs it. Output is JSON; a refusal has a `reason` and the `field` to change.

## Steps

1. **Preview the period** the person asked for. Bill finished days only; `write` refuses a period that reaches today.
2. **Ask once about folders.** If `unbilled` lists folders that are `not mapped`, show them with their hours and ask which client each belongs to, or whether it isn't billed. Get client ids from `solobooks client list`. Record each answer with `map`. The mapping lives in the file named by `config` in the output, which the person can read. Don't ask again about mapped folders, and never guess a client.
3. **Preview again and show the person** the period, the hours per client per day (`per_client_day`), and the sessions behind each entry. Say what went unbilled and which sessions were skipped as program-run. Never quote what was said in a session; you never need to.
4. **Write only after they agree.** Run `write` for the same period. Report each row's status: `added`, `already written` (a re-run, nothing new) or `conflict`.
5. **A conflict** means that day was written before with different hours, because the logs or the mapping changed. Nothing was added. Show both numbers and let the person decide; if they want the new hours, change that entry with `solobooks time edit`.

Then bill as usual with the solobooks skill: the entries are unbilled time like any other.

## Rules

- The rule is fixed. Don't adjust hours, round them yourself or add time the counter didn't find. If the person wants other hours, they can edit the entry; say that's their call.
- Explain a number from the preview's `spans` and `sessions` and from the rule, for example: "Three stretches on Oct 3: 9:02 to 9:58, 13:10 to 14:31 and 16:00 to 17:40, in two sessions. Agent time past 10 minutes after your last message isn't billed."
- The logs are the person's private conversations. The counter reads only times, folders and record kinds. Don't open the log files yourself.
