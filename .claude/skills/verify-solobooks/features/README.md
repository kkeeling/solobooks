# solobooks verification map

This directory is the maintained source for verifying what solobooks does for a person and their agent. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Work from the repo root. `control.ts` means `.claude/skills/verify-solobooks/control.ts`.
- Start a fresh run for each recipe with `control.ts up --seed <seed>`. Ids in the recipes assume that fresh seed.
- Run `control.ts down` before starting the next run. With two runs up, every command refuses until you pass `--run <id>`.
- `control.ts doctor` exits 0 before driving.
- Never drive an instance this run didn't start, and never use the solobooks tools connected to your own session.

## Driving conventions

- Terminal actions go through `control.ts cli -- <args>`. MCP actions go through `control.ts mcp <tool> '<json>'`. Browser actions go through `control.ts page <verb>`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Page handles are ids and data attributes, never position or coordinates.
- Labels and buttons are uppercase in `page text` and in screenshots, so `Owed to you` reads `OWED TO YOU`. Compare them without regard to case.
- A click on the page spends that card's one-time code. Run `control.ts page open` again before acting on a card that appeared after the page loaded.
- Read a decided card's `.outcome` straight away, because the card leaves the page about 3 seconds after the click, and later in a background tab. To read the panels after a decision, run `control.ts page open` again rather than waiting on the old load.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot you looked at, plus the page text. CLI and MCP proof is the transcript with its exit code.
- Mutation proof includes a read-only second view of the stored value from a different surface.
- Pass `--as <sub-feature id>` so every artifact names its feature and entry point.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control.ts` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Approve on the page](./approve-on-page.md) covers approving, rejecting, batches, letting the agent decide, and why only the person can approve.
- [Bill a client](./bill-a-client.md) covers drafting from time and charges, issuing, the PDF and email text, recording it sent, and the MCP entry.
- [Record money](./record-money.md) covers bank statements, payments backed by a bank line, and unbacked payments that wait for approval.
- [Read the page](./read-the-page.md) covers the summary and panels when populated, empty, loading and unreadable.
- [Install and connect](./install-and-connect.md) covers setup, doctor and the MCP server answering.

Not mapped yet: expenses and receipts, credit notes and voids, refunds and client credit, owner money, sales tax, mileage, year-end reports and export, backups and `move`, importing past invoices, editing and deleting drafts, overdue reminders, milestones and recurring fees, `bank match`, `bank unmatch`, matching on import, other statement column layouts, and the agent-time add-on. Add a file here when one of them is the thing being verified.
