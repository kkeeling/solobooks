---
name: verify-solobooks
description: Launch solobooks against throwaway books and drive it the way a person and their agent do, through its CLI, its MCP tools over stdio, and the local approval page in a real browser, capturing proof. Use to confirm a change to solobooks really works, to reproduce a bug in it, or to check invoices, approvals, payments, the page's panels or setup end to end, beyond `bun test`.
---

# Verify solobooks

solobooks has three surfaces. An agent drives the **MCP tools** (`solobooks mcp`, stdio) or the **CLI** (`solobooks <noun> <verb>`). The person looks and approves on the **local page** (`solobooks serve`). The code can also ask in an agent app's own prompt, but no app is verified to offer that, so the page is the path to prove. A proof exercises the surface the behavior reaches a user on. `bun test` is not a proof of a surface.

## Rules that protect the person

- **Never verify with the solobooks tools connected to your own session** (`mcp__solobooks__*`, or `solobooks` on `PATH`). They hold the person's real books. Use `control.ts` only, which gives every command a bare environment with a scratch `HOME`, scratch books and its own port.
- **The browser is Interceptor in the `interceptor-test` Brave profile,** never Playwright, never another profile. `control.ts page` enforces this and refuses when the profile isn't connected.
- **All data is made up.** Don't put real names, numbers or statements into a run.
- **Don't touch a run you didn't start.** With several runs up, `control.ts` refuses to guess; pass `--run <id>` first.

## Helper

`.claude/skills/verify-solobooks/control.ts` is executable and run from the repo root. Below, `control.ts` is short for that path. Flags go right after the command word.

| Command | What it does |
|---|---|
| `control.ts up [--seed empty\|billing\|full] [--now <iso>] [--hold-data-ms <n>]` | Starts a run and prints its id, URL, books folder and evidence folder |
| `control.ts doctor` | Read-only check of the run; exits 1 when it isn't worth driving |
| `control.ts cli [--as <label>] -- <solobooks args>` | Runs the CLI, keeps a transcript, passes through stdout and the exit code |
| `control.ts mcp [--as <label>] <tool> '<json args>'`, `control.ts mcp --list` | Calls one tool over real stdio, as an agent app does, and keeps a transcript |
| `control.ts page [--as <label>] <interceptor verb> ...` | Runs an Interceptor verb on this run's tab group and keeps a transcript |
| `control.ts page open [#fragment] [flags]` | Opens this run's page and no other address |
| `control.ts page shot <name>` | Saves a full-page screenshot into the evidence folder and prints its path |
| `control.ts down` | Stops this run, closes its tabs, removes its scratch folder, keeps the evidence |
| `control.ts list` | Shows every run, stopped or not |

## Launch

```sh
bun install                     # only when node_modules is missing
.claude/skills/verify-solobooks/control.ts up --seed billing
```

`up` runs the real `solobooks setup` in an empty scratch home, which creates the books and applies every migration, then applies the seed and starts `solobooks serve` on a free port. It is ready when it prints `"ready": true`, which it does only after the page's `/data` answered from the books. It runs the source in this checkout, not an installed binary.

| Seed | Starts with | Use for |
|---|---|---|
| `billing` (default) | Jane Doe's profile, client 1 Acme Robotics, 90 minutes at $150, a $48.12 charge, draft invoice 1 for $273.12, and pending action 1 (payment instructions) | Approvals, invoices, money |
| `full` | One pass through every operation, a software passkey registered, gate left to the agent, pending action 2 (`scripts/scenario-books.ts`) | Populated panels |
| `empty` | Fresh books only | First-run states, setup |

The clock is pinned to `2026-10-22T12:00:00.000Z`, the same as the test suite, so totals and due dates repeat. Change it with `--now`. `--hold-data-ms` holds the page's `/data` answer back so its loading state can be seen, and `up` waits it out.

Runs are isolated by port and folder, so several can run side by side.

## Doctor

Run `control.ts doctor` first whenever anything looks off. It changes nothing and checks: the run isn't stopped, its books are inside its scratch folder, the recorded process really serves those books, the port is ours and loopback only, the page answers, `src/` hasn't changed since `up`, `solobooks doctor` passes, the real books file is unchanged, and the browser profile is connected. The last two only warn. A `build` failure means the page is running old code: run `down`, then `up`.

## Drive

Read [features/README.md](features/README.md), then the file for the feature you're proving. In short:

```sh
control.ts cli --as issue-ask -- invoice issue --id 1 --source agent:verify
control.ts mcp --as mcp-unpaid report_unpaid '{}'
control.ts page open
control.ts page --as approve click --selector '[data-approve="2"]'
control.ts page eval --main 'document.querySelector("#pending-2 .outcome").textContent'
control.ts page text
control.ts page shot after-approve
```

Stable page handles: `#pending-<id>`, `[data-approve="<id>"]`, `[data-reject="<id>"]`, `#pending-<id> .outcome`, `input[data-batch="<id>"][value="<invoice id>"]`, `#fig-owed|overdue|net|waiting .value`, `#panel-invoices|unpaid|pnl|changes`, `#h-approvals .count`, `#alert`, `#register`.

Every write needs `--source agent:verify` on the CLI, or `"source":"agent:verify"` in MCP arguments. Money is whole cents and dates are `YYYY-MM-DD`. Don't pass `--books`; `control.ts` already sets the books folder.

## Evidence

Everything lands in `.verify/evidence/<run>/`, which git ignores:

- `NNN-<label>.cli.txt`, `.mcp.txt`, `.page.txt`: the command, stdout, stderr and exit code, in order.
- `NNN-<name>.png`: screenshots. Look at them; a file existing proves nothing about how the page looks.
- `seed.log`, `serve.log`, `run.json`: how the run was set up.
- `books-final/`: written by `down`: the final books file, invoice PDFs and stored statements.

Proof standards:

- Exercise the real user path. Approvals happen by clicking on the page. No approval helper or in-process call counts, including those in `test/support/person.ts`, and the `full` seed's passkey and gate setup is setup only.
- Capture the action and the state after it, from a second view. After a page click, read it back through the CLI. After a CLI write, look at the page.
- Check side effects, not just the reply: the `pending get` status, the invoice's `status` and `number`, `history list`, the PDF in `books-final/invoices/`.
- "Pending" means nothing happened. A result with `"status": "pending"` proves only that it was parked.
- `--dry-run` applies to writes: it leaves the books unchanged, and its reply carries `dry_run: true`. Confirm with `history list` when it matters. Reads ignore it, so `invoice pdf --dry-run` still saves the file.
- Label each artifact with `--as <feature id>` so the proof says which entry point it came from. An entry point you couldn't reach is reported as not verified, with the reason, never passed through another path.

## Cleanup

```sh
control.ts down
```

`down` stops only the process it recorded, after checking that process is this run's server, and never kills by name. It closes this run's tab group, copies the books to `books-final/`, removes the scratch folder and marks the run stopped. Run it after a failed attempt too: a failed `up` is still a run, and `down` cleans it up. Evidence is never deleted by `down`.
