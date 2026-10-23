# The billing rule

Use this to answer "why 3.4 hours?" The counter applies exactly this, and nothing else.

## What counts

1. **You bill from each of your own actions until 10 minutes after it.** An action is something you did in a Claude Code or Codex session:
   - a message you typed, including one typed while the agent was busy, a suggestion you accepted, a slash command, a `!` shell command, or an interrupt;
   - in Claude Code, approving or refusing a tool, and answering the agent's question.
2. **Agent time past the cap counts zero.** If you send one message at 9:00 and the agent works alone until 11:00, that's 10 minutes, 9:00 to 9:10. If your next action is at 9:06, the bill runs on without a break to 9:16.
3. **Parallel sessions never bill one minute twice.** Every session's actions go on one timeline. Each minute goes to the folder of your most recent action before it, so no clock hour can hold more than 60 minutes, however many agents ran at once.
4. **Each project folder belongs to one client.** A session's folder is the one it ran in, and it belongs to the deepest mapped folder that holds it. Time in a folder that isn't mapped, or that you marked as not billed, goes to no one, and the preview lists it under `unbilled`.

## What never counts

- What the agent did on its own: its replies, tool runs, subagents, and Claude Code subagent logs.
- Sessions a program started rather than you: `claude -p` and Agent SDK runs, `codex exec`, Codex MCP and subagent sessions, Codex automations and reviewers. The preview lists them under `skipped_sessions`.
- Messages the harness wrote for you: task notifications, messages from other agents or sessions, hook output, and compaction summaries.

## How the hours are written

- Days are calendar days in the time zone in your mapping file. A stretch that crosses midnight is cut there.
- Each client gets one time entry per day (one per engagement if you mapped folders to different engagements). Its minutes are the exact billable time rounded to the nearest whole minute, once. The client's own rounding in solobooks applies on the invoice as usual.
- Only finished days are written. A day still in progress would grow after it was written.
- Every entry's source names the sessions behind it, and its note names the folders. The preview also shows the exact stretches of time (`spans`) and each session's share.
- Each entry carries a key for its client, engagement and day. Running the counter again for the same days adds nothing. If a day's logs or folder mapping changed since it was written, solobooks refuses the changed entry and the counter reports a `conflict`, so the day is never billed twice.
- The same logs and the same mapping always give the same hours, in whatever order the files are read.

## What it reads

Only structure: what kind of record each log line is, its flags, its time, its session and its folder. It never keeps, prints or sends what anyone wrote. It reads `~/.claude/projects/` and `~/.codex/sessions/` with `~/.codex/archived_sessions/`, and opens no network connection.

The merged-timeline counting follows pmochine/agent-hours (MIT).
