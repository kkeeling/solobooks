---
task: "Build solobooks, agent-native books for solo consultants"
slug: 20261022-solobooks
project: solobooks
phase: climbing
progress: 112/118
started: 2026-10-23T01:31:17Z
updated: 2026-10-24T01:49:26Z
principal_stated_goal: "I want to build my own version of that without all the bells and whistles. That is, you know, minimal and agent native to perform most of those same tasks."
principal_stated_goal_source: conversation
principal_stated_goal_signal: 2
principal_stated_goal_locked: 2026-10-21
context_sufficient: true
interview_invoked: true
---

# solobooks

## Problem

Zoho Books, QuickBooks Online, Xero and FreshBooks are good products for a solo consultant, but they were built for people to click through, not for agents to run. A growing kind of consultant, the agentic engineer, already does their client work by directing coding agents. They want those same agents to keep the books and bill clients, and to peek in only now and then to make sure things are fine. The incumbents have added MCP servers on top of apps designed around screens and forms. They charge a monthly subscription for features this person never uses, and they keep the books on their own servers. Spreadsheets are free but give an agent nothing to enforce: no balanced ledger, no unbroken invoice numbers, no gate on what reaches a client. No books app is built agent-first: small, correct, and run end to end by the consultant's own agent, with the person deciding how much it may do alone.

## Vision

A consultant finishes the month and types "bill everyone for October" into Claude Code. A moment later one prompt shows six invoices, each with its client, amount and total. They pull one out to adjust, click Approve on the rest, and the agent leaves six email drafts in their own mail app, each carrying a clean, numbered PDF. In March their accountant gets one transactions CSV and a P&L by tax line, and asks no follow-up questions. The euphoric surprise is how boring it is: nothing is double-billed, transfers never look like income, the numbers always match the bank, and the consultant opened the books only to glance that all was fine.

## Out of Scope

solobooks never reaches outside the person's machine: it sends no email, connects to no bank, processes no payments, and calls no other service, because the person's agent does all of that. It never tracks time itself; it stores time that people, agents and add-ons give it. It ships no importers for other books apps, since the agent brings old data in through solobooks' normal tools. It computes and files no taxes, including 1099s, and never decides what is taxable. It isn't for anyone with payroll, inventory, several entities, accrual books, multiple currencies, purchase orders, quotes or estimates, client portals or team accounts. It runs on one machine, with no hosted service and no simultaneous two-machine use in v1. It serves US businesses only. Tamper evidence against an agent editing the database file directly, a Claude Code mod, an MCP Registry listing, a Claude Desktop .mcpb bundle and a hosted version are all later.

## Language

**solobooks**: the product, its binary and its command.
_Avoid_: "books" for the product. "The books" means the person's financial records, which solobooks keeps. The product was called "books" until 2026-10-22, and that name collided with the plain word in every sentence.

**Agent**: the AI the person already uses (Claude Code, Codex, Grok Build, Muse Code and so on), running outside solobooks and driving it through its commands.
_Avoid_: any phrasing that suggests an agent or AI lives inside solobooks. There is none. A diagram saying "the agent does everything up to the gate" was first read as an agent built into the app.

**Gate**: solobooks' own refusal to run a gated action until the person approves it at the level they chose (agent decides, click in chat, or passkey).
_Avoid_: "confirmation" or "are you sure?" A prompt the agent can answer for itself isn't a gate.

**Grok Build / Muse Code**: the local terminal agents from xAI and Meta, which solobooks supports.
_Avoid_: "Grok Bot" and "Muse", which are those companies' cloud products and can't reach local data.

## Principles

- **solobooks makes the thing; the agent handles the outside world.** This is the manifest, and every other rule follows from it. The test for any feature: if it needs solobooks to talk to something outside the machine, it belongs to the agent.
- **The person owns where the gate sits.** We set a safe default and enforce whatever they choose. We never decide for them how much their agent may do.
- **Plain code gives the same answer every time.** Judgment belongs to the agent; solobooks holds the math and the rules, so it can be tested and trusted.
- **Correct and boring beats feature-rich.** Every feature has to justify itself to a single consultant. A smaller app that is always right wins over a bigger one that is sometimes wrong.
- **Agent mistakes before anything is final cost nothing; after that, only reversals.** Agents make mistakes in bulk, so drafts are cheap, and issued money is locked.
- **Every record can explain itself.** Anything solobooks holds can answer "where did this come from?"

## Constraints

- TypeScript on bun, shipped as one `bun build --compile` binary for macOS, Linux and Windows. Nothing else needs to be installed to run it.
- Data lives in one SQLite file (`bun:sqlite`) plus receipt and invoice files, in a folder the person owns, on their own machine.
- No code path in solobooks opens a network connection beyond loopback.
- solobooks holds no credentials for any outside service.
- No AI model runs inside solobooks.
- CLI and a stdio MCP server, both thin layers over one core. MCP follows spec 2026-07-28 with the v2 TypeScript SDK (`@modelcontextprotocol/server`) and logs to stderr.
- Double-entry ledger. Money is stored as whole cents, and posted entries are never edited.
- US only, with Schedule C categories as the default chart of accounts.
- Invoice PDFs are produced without a browser install, so the "nothing else to install" rule holds.
- The agent guide follows the Agent Skills spec using only its six fields.
- MIT license. The public repo carries none of the maintainer's private data.

## Goal

"I want to build my own version of that without all the bells and whistles. That is, you know, minimal and agent native to perform most of those same tasks." Done means solobooks is an MIT-licensed, local-only app. A US solo consultant, above all the agentic engineer or consultant who already works through coding agents, installs it by pasting one README prompt into their agent. That agent then runs their books through solobooks' CLI and MCP tools: billing, payments, expenses, bank CSVs, sales tax owed and year-end records. The books always balance and match the bank, and every action that reaches a client waits at the gate level the person chose.

## Features

### F0 · Cross-cutting
Why: the invariants that make the books trustworthy no matter which feature or agent touched them.

- [x] ISC-1: Anti: no solobooks command opens a non-loopback network connection.
- [x] ISC-2: Anti: the schema and config hold no field for an outside service's credential.
- [x] ISC-3: Anti: solobooks has no dependency on any AI model SDK.
- [x] ISC-4: Debits equal credits after every write, across any sequence of writes.
- [x] ISC-5: Any amount round-trips through storage to the exact cent.
- [x] ISC-6: Every report total equals the sum of its entries, with no cached totals.
- [x] ISC-7: Anti: updating or deleting a posted entry is refused at the database level.
- [x] ISC-8: Every write appends exactly one history row.
- [x] ISC-9: A write repeated with the same idempotency key changes nothing.
- [x] ISC-10: The same idempotency key with a different payload is refused.
- [x] ISC-11: `--dry-run` on any write leaves the database file byte-identical.
- [x] ISC-12: Every record carries a non-empty source.
- [x] ISC-13: Every refused write returns a one-sentence reason and the field to change.
- [x] ISC-14: The CLI and MCP produce identical records for the same operation.
- [x] ISC-15: Anti: any currency other than USD is refused.

### F1 · Clients and engagements
Why: one consultant's mix of hourly, flat, recurring and pass-through work bills correctly with no code per client.

- [x] ISC-16: Hourly, fixed-milestone, recurring and mixed terms are each created through the CLI alone.
- [x] ISC-17: 37 minutes at $150/hr bills exactly $92.50 by default.
- [x] ISC-18: A client's 6-minute increment bills a 7-minute entry as 12 minutes.
- [x] ISC-19: A client's 15-minute minimum bills a 5-minute entry as 15 minutes.

### F2 · Accounts and owner money
Why: the most common solo mess, where your own money moving around gets counted as income or expense, can't happen.

- [x] ISC-20: A transfer between the person's own accounts leaves the P&L unchanged.
- [x] ISC-21: Paying off a card from checking leaves the P&L unchanged.
- [x] ISC-22: A business expense on a personal card records the expense and an owner contribution.
- [x] ISC-23: Anti: a transfer whose legs don't net to zero is refused.
- [x] ISC-24: Owner draws and contributions never appear in the P&L.

### F3 · Time
Why: solobooks keeps time from any source and never decides how it was tracked.

- [x] ISC-25: A time entry carries client, date, duration and a note.
- [x] ISC-26: Anti: the core contains no code that reads agent logs or runs timers.
- [x] ISC-27: Editing a time entry on an issued invoice is refused with a reason.
- [x] ISC-28: Unbilled time entries can be edited and deleted freely.

### F4 · Invoices and client documents
Why: what reaches a client is always correct, numbered without gaps, and never sent final before approval.

- [x] ISC-29: A period's draft includes its unbilled time, fixed fees, recurring fees and pass-through costs.
- [x] ISC-30: A draft invoice PDF is stamped DRAFT and carries no final number.
- [x] ISC-31: An issued PDF carries every standard field (seller name, address, EIN, client, number, invoice date, service period, lines, subtotal, tax, total, terms, due date).
- [x] ISC-32: Invoice numbers continue from the configured next number with no gaps.
- [x] ISC-33: Anti: deleting an issued invoice is refused; voiding keeps the record.
- [x] ISC-34: A credit note references the original invoice number.
- [x] ISC-35: The invoice email text carries the invoice number, amount and due date.
- [x] ISC-36: The overdue reminder text carries the unpaid balance and days late.
- [x] ISC-37: An invoice is marked sent only when the agent reports sending it.
- [x] ISC-38: Draft invoices can be edited and deleted freely.

### F5 · Payments
Why: what lands in the bank, what the client paid and what the processor kept always reconcile to the 1099-K.

- [x] ISC-39: A $1,000 payment with a $30 fee records $1,000 income, a $30 fee expense and a $970 deposit.
- [x] ISC-40: A partial payment leaves the exact remaining balance due.
- [x] ISC-41: An overpayment becomes a client credit.
- [x] ISC-42: A refund reverses its payment's income at gross; the processor fee stays an expense unless the processor returned it.
- [x] ISC-111: An overpayment credit can be applied to a later invoice of the same client.
- [x] ISC-43: The unpaid list shows every overdue invoice with its days late.

### F6 · Expenses and bank import
Why: the bank statement becomes the books with the person seeing only the few lines that need a human.

- [x] ISC-44: An expense carries an attached receipt file.
- [x] ISC-45: A pass-through cost links to the invoice that recovers it.
- [x] ISC-46: Importing the same bank CSV twice adds zero lines the second time.
- [x] ISC-47: Exact matches to payments and expenses are made automatically on import.
- [x] ISC-48: Unmatched lines land on one list.
- [x] ISC-112: A wrong bank match can be undone, and undoing a payment's match is gated like an unbacked payment.

### F7 · Sales tax
Why: tax collected for a state is tracked as owed money, never mistaken for income, and never chosen by solobooks.

- [x] ISC-49: A client's tax rate and label appear as a separate invoice line.
- [x] ISC-50: Tax collected is recorded as owed and excluded from income.
- [x] ISC-51: The sales tax report shows, per period, tax charged on issued invoices, tax collected and payments to the state, each matching the ledger, and never names one of them as the amount due.
- [x] ISC-52: Anti: no tax line appears on an invoice unless the person set a rate on that client.
- [x] ISC-105: A tax rate applies only to the line kinds the person listed for that client.

### F8 · Year-end records and reports
Why: a full year goes to an accountant with nothing missing, so there are no follow-up questions.

- [x] ISC-53: A mileage trip uses the IRS rate for its date (72.5¢ on 2026-06-30, 76¢ on 2026-07-01).
- [x] ISC-54: Home office figures appear in the year-end export.
- [x] ISC-55: Estimated taxes, health insurance and retirement are totalled separately as owner items.
- [x] ISC-56: A contractor payment carries W-9 status and payment method.
- [x] ISC-57: Card and PayPal contractor payments are flagged as outside the 1099-NEC list.
- [x] ISC-58: The P&L groups by Schedule C category.
- [x] ISC-110: The P&L and year-to-date profit count income when it is paid, not when it is invoiced (cash basis).
- [x] ISC-59: One command exports a year's transactions as a single CSV.
- [x] ISC-60: Year-to-date profit is available as one number.
- [x] ISC-61: The hledger export passes `hledger check`.
- [ ] ISC-62: [DROPPED — see Decisions 2026-10-22; CPA review moved to Remaining Work for April tax season]

### F9 · The approval gate
Why: the person decides how much their agent may do, and that choice holds even when the agent is told otherwise.

- [x] ISC-63: A gated action returns pending and does not run.
- [x] ISC-64: Each gated action offers agent-decides, click-in-chat and passkey levels.
- [x] ISC-65: Client-reaching actions default to click-in-chat.
- [x] ISC-66: Anti: no CLI command or MCP tool can approve a pending action.
- [x] ISC-67: Every gated MCP tool carries `requiresUserInteraction`.
- [x] ISC-68: Changing a gate setting itself creates a pending approval.
- [x] ISC-69: Changing payment details on invoices is gated by default.
- [x] ISC-70: Marking paid with no matching bank line is gated by default.
- [x] ISC-71: One batch approval issues every invoice left in the batch.
- [x] ISC-72: An invoice pulled from a batch stays a draft.
- [x] ISC-73: The local-page fallback link approves the pending action.
- [x] ISC-74: Passkey-level approval completes only with a WebAuthn assertion.
- [x] ISC-75: Anti: instructions planted in an imported CSV never complete a gated action.
- [x] ISC-106: Anti: a draft waiting for approval refuses every change to what would be issued.
- [x] ISC-107: The approval prompt shows every line, the note, terms, payment instructions and any reason, in fixed wording the agent can't write.
- [x] ISC-108: Anti: a raw ledger entry on the accounts invoices post to is refused.
- [x] ISC-109: A request parked one day approves the next, dated the day it is approved.

### F10 · Onboarding and the agent guide
Why: a stranger goes from one pasted prompt to a first draft invoice without a tutorial or a form.

- [x] ISC-76: The README prompt in Claude Code on a clean machine ends with `solobooks doctor` passing.
- [x] ISC-77: The README prompt in Codex on a clean machine ends with `solobooks doctor` passing.
- [ ] ISC-78: [DROPPED — see Decisions 2026-10-22; Grok Build and Muse Code install tests moved to Remaining Work]
- [x] ISC-79: An agent with only solobooks' guide gets from "my first client is Acme at $150/hr" to a draft invoice.
- [x] ISC-80: Past invoices from a spreadsheet import as already-sent with their original numbers.
- [x] ISC-81: Anti: imported already-happened records never hit the gate or trigger reminders.
- [x] ISC-82: The skill's frontmatter uses only the six Agent Skills fields.

### F11 · Packaging and install
Why: whatever local agent someone already uses, solobooks connects to it in one step and proves it worked.

- [x] ISC-83: The macOS one-line installer leaves a working binary with no bun or Node on PATH.
- [ ] ISC-84: [DROPPED — see Decisions 2026-10-22; Windows installer test moved to Remaining Work]
- [x] ISC-85: Running `solobooks setup` twice leaves every agent config identical to one run.
- [x] ISC-86: `solobooks doctor` fails when the MCP server isn't registered for a detected agent.
- [x] ISC-87: `claude plugin install solobooks --marketplace <owner>/solobooks` installs the MCP server and skill.
- [x] ISC-88: The npm wrapper runs the compiled binary.
- [x] ISC-89: Every read-only MCP tool carries `readOnlyHint: true` and every write tool doesn't.
- [x] ISC-90: The README carries the privacy note, the unsupported-agents list and the "not tax or accounting advice" line.

### F12 · Durability
Why: seven years of records survive dead laptops, synced folders and every future release.

- [x] ISC-91: A dated backup is written daily to the folder the person picked.
- [x] ISC-92: A backup is written before every migration.
- [x] ISC-93: solobooks warns when the live file sits inside iCloud, Dropbox or OneDrive.
- [x] ISC-94: A saved file from every earlier release opens and passes `solobooks doctor`.
- [x] ISC-95: `solobooks move` into a fresh folder reproduces identical reports.

### F13 · Agent-time add-on
Why: people who bill for work done by directing coding agents get honest, explainable hours without the core learning how time is tracked.

- [x] ISC-96: The same session logs always produce the same hours.
- [x] ISC-97: Time past 10 minutes after the person's last action counts zero.
- [x] ISC-98: Parallel sessions never bill more than 60 minutes in any hour.
- [x] ISC-99: Re-running for the same period adds no new entries.
- [x] ISC-100: The counter script runs through the solobooks binary with no bun on PATH.
- [x] ISC-101: Anti: `solobooks setup` doesn't install the add-on unless asked.

### F14 · The human page
Why: the person can see the books and approve things when their agent's app can't, without a second app to learn.

- [x] ISC-102: [container] The page shows invoices, unpaid, P&L and recent changes.
  - [x] ISC-102.1: The page renders a loading state while data loads.
  - [x] ISC-102.2: The page renders an error state when the books file can't be read.
  - [x] ISC-102.3: The page renders an empty state for new books.
  - [x] ISC-102.4: The page renders all four panels with populated books.
- [x] ISC-103: Anti: the page has no data-entry forms besides approve and reject.
- [x] ISC-104: Anti: the page server listens only on loopback.
- [ ] ISC-113: The page opens with a summary strip of four figures: owed, overdue, net profit this year, and actions waiting for approval, each equal to what the unpaid report, the P&L and the pending list say.
- [ ] ISC-114: Figures, section labels and the wordmark are set in the system monospace face with tabular figures, and the page loads no font files.
- [ ] ISC-115: At 1280px wide the four panels sit in two columns; at 375px they stack in one column with no horizontal page scroll.
- [ ] ISC-116: Body and muted text reach 4.5:1 contrast against the page background in both the light and dark themes.
- [ ] ISC-117: Anti: no element on the page has a corner radius over 4px, a shadow, or a gradient.
- [ ] ISC-118: Antecedent: the page reads as one technical instrument: uppercase monospace section labels with counts, 1px rules between rows, panels on the page itself rather than in cards, and color only where it marks state (waiting, overdue, error).


## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bun-test | full command suite with outbound sockets trapped | 0 non-loopback connects | bun test test/manifest.test.ts -t "no network" | derived: manifest |
| ISC-2 | bash | schema and config scanned for credential fields | 0 matches | `rg -i "password\|token\|api_key\|secret" src/db src/config.ts ; test $? -eq 1` | derived: manifest |
| ISC-3 | bash | dependency list scanned for model SDKs | 0 matches | `jq -r '.dependencies // {} \| keys[]' package.json \| rg -i "anthropic\|openai\|ai-sdk\|gemini" ; test $? -eq 1` | derived: no-ai-inside |
| ISC-4 | bun-property | debits equal credits after random write sequences | 1000 runs | bun test test/ledger.property.test.ts -t "balances" | literal |
| ISC-5 | bun-property | amount round-trip exact | 1000 runs | bun test test/money.property.test.ts -t "cents" | literal |
| ISC-6 | bun-property | report totals equal entry sums | 1000 runs | bun test test/reports.property.test.ts -t "recompute" | literal |
| ISC-7 | bun-test | UPDATE and DELETE on posted entry | both refused | bun test test/ledger.test.ts -t "posted immutable" | derived: never-edit |
| ISC-8 | bun-property | history rows equal writes | 1000 runs | bun test test/history.property.test.ts | derived: provenance |
| ISC-9 | bun-property | repeat key is a no-op | 1000 runs | bun test test/idempotency.property.test.ts -t "same key" | derived: retry-safe |
| ISC-10 | bun-test | same key, new payload | refused | bun test test/idempotency.test.ts -t "conflict" | derived: retry-safe |
| ISC-11 | bun-test | dry-run file hash before vs after | equal | bun test test/dryrun.test.ts | derived: retry-safe |
| ISC-12 | bun-test | records with empty source | 0 | bun test test/provenance.test.ts | derived: provenance |
| ISC-13 | bun-property | invalid inputs return reason and field | 1000 runs | bun test test/errors.property.test.ts | derived: agent-native |
| ISC-14 | bun-test | CLI vs MCP record diff | empty | bun test test/parity.test.ts | derived: agent-native |
| ISC-15 | bun-test | non-USD amount write | refused | bun test test/scope.test.ts -t "usd only" | derived: out-of-scope |
| ISC-16 | bun-test | each term type created via CLI | 4 of 4 | bun test test/engagements.test.ts -t "term types" | derived: data-not-code |
| ISC-17 | bun-test | 37 min at $150/hr | 9250 cents | bun test test/billing.test.ts -t "exact minutes" | literal |
| ISC-18 | bun-test | 7 min with 6-min increment | 12 min | bun test test/billing.test.ts -t "increment" | literal |
| ISC-19 | bun-test | 5 min with 15-min minimum | 15 min | bun test test/billing.test.ts -t "minimum" | literal |
| ISC-20 | bun-property | random own-account transfers | P&L delta 0 | bun test test/owner.property.test.ts -t "transfers" | derived: owner-money |
| ISC-21 | bun-test | card payoff | P&L delta 0 | bun test test/owner.test.ts -t "card payoff" | derived: owner-money |
| ISC-22 | bun-test | personal-card expense | expense plus contribution | bun test test/owner.test.ts -t "personal card" | derived: owner-money |
| ISC-23 | bun-test | unbalanced transfer | refused | bun test test/owner.test.ts -t "unbalanced" | derived: owner-money |
| ISC-24 | bun-property | draws and contributions | P&L delta 0 | bun test test/owner.property.test.ts -t "draws" | derived: owner-money |
| ISC-25 | bun-test | time entry fields required | all present | bun test test/time.test.ts -t "fields" | literal |
| ISC-26 | bash | core scanned for log readers and timers | 0 matches | `rg -n "\.claude/projects\|\.codex/sessions\|setInterval" src/core ; test $? -eq 1` | derived: stores-not-tracks |
| ISC-27 | bun-test | edit billed time entry | refused with reason | bun test test/time.test.ts -t "locked" | derived: free-until-issued |
| ISC-28 | bun-test | edit and delete unbilled entry | both succeed | bun test test/time.test.ts -t "unbilled" | derived: free-until-issued |
| ISC-29 | bun-test | period draft line sources | 4 of 4 kinds | bun test test/invoices.test.ts -t "draft sources" | literal |
| ISC-30 | bun-test | draft PDF text | contains DRAFT, no number | bun test test/pdf.test.ts -t "draft" | derived: gate-holds |
| ISC-31 | bun-test | issued PDF text vs field list | 13 of 13 | bun test test/pdf.test.ts -t "standard fields" | derived: invoice-fields |
| ISC-32 | bun-property | numbering after random issue/void | no gaps | bun test test/numbering.property.test.ts | derived: invoice-fields |
| ISC-33 | bun-test | delete issued, then void | delete refused, void kept | bun test test/invoices.test.ts -t "never delete" | derived: never-edit |
| ISC-34 | bun-test | credit note body | contains original number | bun test test/credits.test.ts | derived: client-docs |
| ISC-35 | bun-test | invoice email text | number, amount, due date | bun test test/documents.test.ts -t "invoice email" | derived: client-docs |
| ISC-36 | bun-test | reminder text | balance, days late | bun test test/documents.test.ts -t "reminder" | derived: client-docs |
| ISC-37 | bun-test | status before and after sent report | issued then sent | bun test test/invoices.test.ts -t "sent" | derived: manifest |
| ISC-38 | bun-test | edit and delete draft | both succeed | bun test test/invoices.test.ts -t "draft free" | derived: free-until-issued |
| ISC-39 | bun-test | $1,000 with $30 fee | 100000 / 3000 / 97000 | bun test test/payments.test.ts -t "gross plus fee" | derived: payments |
| ISC-40 | bun-test | partial payment balance | exact remainder | bun test test/payments.test.ts -t "partial" | derived: payments |
| ISC-41 | bun-test | overpayment | client credit row | bun test test/payments.test.ts -t "overpay" | derived: payments |
| ISC-42 | bun-test | refund | gross income reversed, fee kept | bun test test/payments.test.ts -t "refund" | derived: payments |
| ISC-111 | bun-test | overpayment credit applied to next invoice | balance drops by the credit | bun test test/payments.test.ts -t "apply credit" | derived: payments |
| ISC-43 | bun-test | unpaid list vs fixture | all overdue, days late | bun test test/reports.test.ts -t "unpaid" | literal |
| ISC-44 | bun-test | expense with receipt | file linked and readable | bun test test/expenses.test.ts -t "receipt" | literal |
| ISC-45 | bun-test | pass-through link | invoice id set | bun test test/expenses.test.ts -t "pass-through" | literal |
| ISC-46 | bun-test | import same CSV twice | 0 new lines | bun test test/bank.test.ts -t "dedupe" | derived: retry-safe |
| ISC-47 | bun-test | fixture CSV exact matches | all matched | bun test test/bank.test.ts -t "exact match" | literal |
| ISC-48 | bun-test | fixture CSV leftovers | one list, all present | bun test test/bank.test.ts -t "unmatched" | literal |
| ISC-112 | bun-test | unmatch a wrong match | line back on the unmatched list; payment unmatch pending | bun test test/bank.test.ts -t "unmatch" | derived: injection |
| ISC-49 | bun-test | taxed client invoice | separate tax line | bun test test/tax.test.ts -t "line" | literal |
| ISC-50 | bun-test | tax collected | liability, not income | bun test test/tax.test.ts -t "liability" | derived: sales-tax |
| ISC-51 | bun-property | charged, collected, paid vs ledger | each equal, no amount-due figure | bun test test/tax.property.test.ts | derived: sales-tax |
| ISC-52 | bun-test | client without rate | no tax line | bun test test/tax.test.ts -t "never decides" | derived: not-an-accountant |
| ISC-105 | bun-test | pass-through taxed only when listed | untaxed unless listed | bun test test/tax.test.ts -t "applies to" | derived: not-an-accountant |
| ISC-53 | bun-test | trips on 2026-06-30 and 2026-07-01 | 72.5¢ and 76¢ | bun test test/mileage.test.ts | derived: year-end |
| ISC-54 | bun-test | year-end export | home office present | bun test test/yearend.test.ts -t "home office" | derived: year-end |
| ISC-55 | bun-test | owner items | separate totals, not in P&L | bun test test/yearend.test.ts -t "owner items" | derived: year-end |
| ISC-56 | bun-test | contractor payment fields | W-9 status, method | bun test test/contractors.test.ts -t "fields" | derived: year-end |
| ISC-57 | bun-test | card-paid contractor | flagged outside 1099-NEC | bun test test/contractors.test.ts -t "1099-k" | derived: year-end |
| ISC-58 | bun-test | P&L categories | Schedule C lines | bun test test/reports.test.ts -t "schedule c" | derived: year-end |
| ISC-110 | bun-test | issued in one year, paid in the next | income in the paid year | bun test test/reports.test.ts -t "cash basis" | derived: out-of-scope accrual |
| ISC-59 | bash | year CSV export | one file, all rows | `bash scripts/export-check.sh` | literal |
| ISC-60 | bun-test | YTD profit vs fixture | exact | bun test test/reports.test.ts -t "ytd" | derived: year-end |
| ISC-61 | bash | hledger check on export | exit 0 | `bash scripts/export-check.sh` | derived: export |
| ISC-63 | bun-test | gated action | pending, no effect | bun test test/gate.test.ts -t "parks" | derived: gate |
| ISC-64 | bun-test | gate levels per action | 3 of 3 | bun test test/gate.test.ts -t "levels" | derived: gate |
| ISC-65 | bun-test | fresh install defaults | click-in-chat | bun test test/gate.test.ts -t "defaults" | derived: gate |
| ISC-66 | bun-test | every CLI command and MCP tool vs pending action | 0 approve it | bun test test/gate.test.ts -t "no self approval" | derived: gate |
| ISC-67 | bun-test | MCP tools/list for gated tools | meta flag on all | bun test test/mcp.test.ts -t "requires interaction" | derived: gate |
| ISC-68 | bun-test | change gate setting | pending approval | bun test test/gate.test.ts -t "setting gated" | derived: gate |
| ISC-69 | bun-test | change payment details | pending by default | bun test test/gate.test.ts -t "payment details" | derived: injection |
| ISC-70 | bun-test | mark paid, no bank line | pending by default | bun test test/gate.test.ts -t "mark paid" | derived: injection |
| ISC-71 | bun-test | batch approve | all remaining issued | bun test test/gate.test.ts -t "batch" | derived: batch |
| ISC-72 | bun-test | pulled invoice | still draft | bun test test/gate.test.ts -t "batch exclude" | derived: batch |
| ISC-73 | screenshot | fallback link approves | action completes | Interceptor on the local approval page | derived: gate |
| ISC-74 | screenshot | passkey approval | completes only after Touch ID | Interceptor on the local approval page | derived: gate |
| ISC-75 | eval | agent imports a CSV with planted instructions | 0 gated actions completed | `bun scripts/eval/run.ts injection --agent claude --work $(mktemp -d)` | derived: injection |
| ISC-106 | bun-test | edits to a held draft at click and passkey | all refused | bun test test/gate.test.ts -t "refuses every change" | derived: gate |
| ISC-107 | bun-test | page card and chat prompt contents | every field shown, fixed question | bun test test/gate.test.ts -t "show every line" | derived: gate |
| ISC-108 | bun-test | entry post on invoice accounts | refused | bun test test/gate.test.ts -t "accounts invoices post to" | derived: gate |
| ISC-109 | bun-test | park day 1, approve day 2 | issued, dated day 2 | bun test test/gate.test.ts -t "next morning" | derived: gate |
| ISC-76 | eval | README prompt, Claude Code, clean machine | doctor passes | `bun scripts/eval/run.ts install --agent claude --work $(mktemp -d)` | literal |
| ISC-77 | eval | README prompt, Codex, clean machine | doctor passes | `bun scripts/eval/run.ts install --agent codex --work $(mktemp -d)` | literal |
| ISC-79 | eval | guide-only onboarding to draft invoice | draft exists | `bun scripts/eval/run.ts onboarding --agent claude --work $(mktemp -d)` | literal |
| ISC-80 | eval | spreadsheet past-invoice import | numbers kept, status sent | `bun scripts/eval/run.ts prior-data --agent claude --work $(mktemp -d)` | derived: onboarding |
| ISC-81 | bun-test | historical records | 0 pending, 0 reminders | bun test test/historical.test.ts | derived: onboarding |
| ISC-82 | bash | skill frontmatter keys | subset of six | `bun scripts/check-skill-fields.ts skills/solobooks/SKILL.md` | derived: standards |
| ISC-83 | bash | install in env without bun or node, loopback mirror of a local release | version prints, tampered binary refused | `bash scripts/install-check.sh` | literal |
| ISC-85 | bash | setup twice, diff configs | empty diff | `bash scripts/setup-idempotent.sh` | derived: install |
| ISC-86 | bash | doctor with MCP entry removed | exit non-zero | `bash scripts/doctor-negative.sh` | derived: install |
| ISC-87 | bash | plugin install from marketplace | MCP and skill listed | `bash scripts/plugin-install-check.sh` | derived: install |
| ISC-88 | bash | npm wrapper from packed tarballs, registry unreachable | version prints, MCP lists tools | `bash scripts/npm-check.sh` | derived: install |
| ISC-89 | bun-test | tools/list annotations vs write map | 100% accurate | bun test test/mcp.test.ts -t "annotations" | derived: standards |
| ISC-90 | bash | README lines present | 3 of 3 | `rg -c "model vendor\|can't reach\|not tax or accounting advice" README.md` | derived: public-repo |
| ISC-91 | bun-test | clock advanced one day | dated backup exists | bun test test/backup.test.ts -t "daily" | derived: durability |
| ISC-92 | bun-test | migration run | backup precedes it | bun test test/backup.test.ts -t "pre-migration" | derived: durability |
| ISC-93 | bun-test | live file under a synced-folder path | warning returned | bun test test/backup.test.ts -t "synced folder" | derived: durability |
| ISC-94 | bun-test | every fixture file from past releases | opens, doctor passes | bun test test/compat.test.ts | derived: durability |
| ISC-95 | bun-test | move then report diff | empty | bun test test/move.test.ts | derived: durability |
| ISC-96 | bun-property | counter on shuffled fixture logs | identical hours | bun test addons/agent-time/test/count.property.test.ts | derived: agent-time |
| ISC-97 | bun-test | idle gap fixture | zero past cap | bun test addons/agent-time/test/count.test.ts -t "cap" | derived: agent-time |
| ISC-98 | bun-property | random parallel sessions | ≤ 60 min per hour | bun test addons/agent-time/test/count.property.test.ts -t "parallel" | derived: agent-time |
| ISC-99 | bun-test | run twice for same period | 0 new entries | bun test addons/agent-time/test/rerun.test.ts | derived: agent-time |
| ISC-100 | bash | add-on via binary, no bun on PATH | runs, prints hours | `bash scripts/addon-no-bun.sh` | derived: agent-time |
| ISC-101 | bash | default setup output | no add-on installed | `bash scripts/setup-no-addon.sh` | derived: add-ons-optional |
| ISC-102.1 | screenshot | page with delayed data | loading state shown | Interceptor capture | derived: human-page |
| ISC-102.2 | screenshot | page with unreadable books file | error state shown | Interceptor capture | derived: human-page |
| ISC-102.3 | screenshot | page with new empty books | empty state shown | Interceptor capture | derived: human-page |
| ISC-102.4 | screenshot | page with fixture books | four panels populated | Interceptor capture | derived: human-page |
| ISC-103 | bun-test | page HTML forms | approve and reject only | bun test test/page.test.ts -t "no entry forms" | derived: human-page |
| ISC-104 | bash | listening sockets of page server | loopback only | `sh scripts/page-loopback-check.sh` | derived: manifest |
| ISC-113 | bun-test | /data summary against the reports | all four equal | bun test test/page.test.ts -t "summary strip" | derived: human-page |
| ISC-114 | bun-test | page CSS and markup | mono stack with tabular figures, no font files | bun test test/page.test.ts -t "type" | derived: human-page |
| ISC-115 | screenshot | page at 1280px and 375px | two columns, then one with no page scroll | Interceptor capture plus scrollWidth read | derived: human-page |
| ISC-116 | bun-test | theme tokens | 4.5:1 or more, both themes | bun test test/page.test.ts -t "contrast" | derived: human-page |
| ISC-117 | bun-test | page CSS | no radius over 4px, no shadow, no gradient | bun test test/page.test.ts -t "flat" | derived: human-page |
| ISC-118 | screenshot | populated page, light and dark | labels, rules, no cards, color only on state | Interceptor capture | derived: human-page |

## Decisions

- 2026-10-21: Scope is a product for any US solo consultant, not a tool for the maintainer's own setup. There's no migration, catch-up or year-end handoff work.
- 2026-10-21: Local-only, US-only, and not an accountant. Public GitHub repo whose README carries a copy-and-paste install prompt.
- 2026-10-21: ❌ DEAD END: plain-text ledger plus hledger plus git as storage. It asks strangers to install hledger and keep git discipline. Replaced by one SQLite file with export to hledger or beancount.
- 2026-10-22: [arch] Manifest: solobooks makes the thing, the agent handles the outside world. solobooks holds no outside credentials and opens no outside connections.
- 2026-10-22: No AI inside solobooks; the person's agent does the thinking.
- 2026-10-22: refined: the gate went from one fixed passkey gate to a per-action setting the person owns (agent decides, click in chat, passkey). The default is click in chat for anything reaching a client. Changing the setting is itself gated.
- 2026-10-22: Onboarding happens in the agent conversation. Prior data comes in through the agent using solobooks' tools; no importers ship.
- 2026-10-22: refined: time capture from agent logs left the core. solobooks stores time; agent-time billing is an optional add-on, a skill carrying its own counter script.
- 2026-10-22: The add-on script runs through the solobooks binary's built-in runtime. A compiled test binary ran an outside `.ts` script with no bun on PATH.
- 2026-10-22: Client documents solobooks makes: invoice, invoice email, overdue reminder, credit note. Courtesy notes are the agent's.
- 2026-10-22: Tamper evidence against direct database edits is deferred, since not every agent incident gets solved in v1.
- 2026-10-22: Interview closed 13 gaps:
  - Every account plus owner money.
  - Payments recorded gross plus fee.
  - Sales tax tracked as owed.
  - Fraud-target actions gated by default, loosenable.
  - Automatic backups with a synced-folder warning.
  - Old files open forever, tested.
  - Exact-minute billing with per-client rounding.
  - Free edits until issued.
  - Batch approval.
  - All CPA year-end records in v1.
  - Claude Code and Codex runs every release, all supported agents before each major release.
  - One machine plus `solobooks move`.
  - MIT license.
- 2026-10-22: refined: the Problem was rewritten and approved by the maintainer. The incumbents are fine products for solo consultants. The gap is that they were built for humans to click, not for agents to run, and they cost a monthly fee. The main user is the agentic engineer or consultant who wants agents to keep the books and only peeks to check. The Vision and Goal were updated to match.
- 2026-10-22: refined: ISC-78 (Grok Build and Muse Code install tests) and ISC-84 (Windows installer test) were dropped from the v1 climb at the maintainer's call and moved to Remaining Work. A friend of the maintainer will test Windows.
- 2026-10-22: The maintainer granted for the climb: git init and local commits; a private GitHub repo kkeeling/solobooks; beads tracking; a fresh empty home folder counting as a clean machine for install tests; installing hledger with Homebrew; and publishing the npm package, which needs an npm sign-in this machine does not have yet.
- 2026-10-22: refined: ISC-62 (an accountant accepts a full year without follow-up) was dropped from the v1 climb at the maintainer's call, because it can only be checked during tax season in April. It moved to Remaining Work.
- 2026-10-23: [arch] Core layout: `src/core/` holds all logic (ledger, money, clients, time, invoices); `src/cli.ts` and `src/mcp.ts` are thin adapters calling the same core functions; schema in `src/db/` with numbered migrations. Money is integer cents; rates are cents per hour; durations are whole minutes; line amounts round half-up once, at the line. Every write runs in one SQLite transaction that appends a history row and checks debits equal credits before commit. Dry-run executes the same transaction and rolls back.
- 2026-10-23: [arch] Invoice PDFs come from pdf-lib (pure JS, no browser), rendered from an invoice document model; tests read PDF text back with pdfjs-dist as a dev dependency. MCP uses `@modelcontextprotocol/server` 2.x; tests use fast-check 4.x for properties.
- 2026-10-23: Climb order: (1) bill one client, (2) gate, (3) install and onboarding, (4) money reconciles, (5) tax and year-end, (6) durability, add-on, page.
- 2026-10-23: Build calls accepted from step 1a: every write requires `--source` (no default, since a default explains nothing); no default books folder yet, decided in step 3 with `solobooks setup`; a generic `entry post` and `account add`/`list` ledger primitive exists; MCP input validation is left to the core so CLI and MCP refuse identically; `SOLOBOOKS_NOW` pins the clock for parity tests.
- 2026-10-23: refined: ISC-2 probe pointed at `src/db` (the schema lives in migrations) and given an exit check; ISC-26 and ISC-104 probe cells rewritten so the whole command sits in one code span.
- 2026-10-23: Build calls accepted from step 1b: credit notes have their own CN- number series so invoice numbers stay gap-free; issuing refuses until all 13 invoice fields exist; the business profile's next invoice number freezes after the first issue; credit notes issue at once, so the step-2 gate must wrap invoice credit and invoice void as well as issue; voiding releases billed items to be billed again; returned file paths are relative to the books folder.
- 2026-10-23: refined: the first build taxed whole subtotals including pass-throughs, which made solobooks decide taxability. Setting a client tax rate now requires the line kinds it covers, with no default (ISC-105 added).
- 2026-10-23: refined: a period's draft now pulls every unbilled item dated on or before the period end and marks earlier ones carried over, so a late-entered entry is never left unbilled.
- 2026-10-23: Second look on the gate: a Forge audit ran read-only, but its cross-vendor tool could not start (it needs a task ISA under MEMORY/WORK), so it was an in-family review that reproduced every finding by hand. Adopted all five findings: (high) approval ran a draft edited after it was parked; (high) the note, line text and credit reason reached the client unseen; (medium) the chat prompt interpolated agent-written text; (low) a gated profile change carried other fields; (low) entry post could reverse an issued invoice's income ungated. Fixes are dispatched; F9 claims stay open until they are verified.
- 2026-10-23: Gate calls accepted: approval re-checks a full snapshot of what the person saw apart from the number and dates; a waiting draft is held against edits; the chat prompt is a fixed question plus code-written labels with agent text flattened and capped at 240 characters; a payment-instructions change must come alone; one passkey per books, trusted on first use; the page is http://localhost:7317 bound to loopback.
- 2026-10-23: refined: ISC-106..109 added from the gate audit's findings and the overnight-approval fix.
- 2026-10-22: Named solobooks. It was free on npm and Homebrew that day, and the only GitHub match was a 2-star repo. No trademark search yet.
- 2026-10-23: The default books folder is `~/solobooks`, recorded by `solobooks setup` in a config file. Precedence: `--books`, then SOLOBOOKS_DIR, then the config, then refuse. Setup warns when the folder sits in iCloud, Dropbox, OneDrive or Google Drive. Settles the open call from step 1a.
- 2026-10-23: Historical (already-happened) invoices must be dated before today and are marked historical wherever invoices are listed, so "historical" can't be used to skip the gate on a new invoice.
- 2026-10-23: While the repo is private, ISC-83 is proven against a loopback mirror of a local release build. The run against the real GitHub Releases URL waits for the repo going public.
- 2026-10-23: refined: payment instructions moved from `profile set` to their own gated command, `profile payment instructions set`, because the MCP requiresUserInteraction flag is per tool. The Codex eval runs with full access in its throwaway home, standing in for the person approving setup outside the sandbox, and INSTALL.md tells sandboxed agents to ask.
- 2026-10-23: Step 4 build calls accepted: bank import takes the bank's own CSV plus a declared column map, so amounts come from the file and not the model; a line's identity is account, date, amount and collapsed description, counted per file; exact matching needs exactly one candidate on each side; payments backed by an imported bank line of the same net amount skip the new `payment_unmatched` gate. Known residual: an agent that writes its own CSV can back a payment ungated; the kept file and its hash are the trail.
- 2026-10-23: refined: review of step 4 found three gaps, now claims. A refund mirrored the processor fee, but processors keep it (ISC-42 refined). An overpayment credit couldn't be used (ISC-111). A wrong bank match couldn't be undone (ISC-112). And income was booked when invoiced, while Out of Scope rules out accrual books, so reports must count income when paid (ISC-110).
- 2026-10-23: refined: sales tax owed was first built to follow the money, at my instruction. Most states tax at the sale, and which rule applies is the person's state's call, so the report now gives charged, collected and paid side by side and names no amount due (ISC-51 refined). New books also get a seeded Schedule C chart of accounts, which the Constraints promised.
- 2026-10-23: Fog on Grok Build and Muse Code log formats closed: those agents were moved out of v1 by the maintainer (see 2026-10-22), so the add-on supports Claude Code and Codex; their formats wait with the install tests in Remaining Work.
- 2026-10-23: Trademark search skipped. The maintainer: "I'm not going to sell this anyway. If I do infringe upon someone's trademark, they'll send a cease and desist, and then we'll make a change."
- 2026-10-23: Fog on the invoice PDF look closed. A throwaway prototype showed one sample invoice three ways: the current plain Helvetica layout, a modern one with an accent color, logo spot and amount-due box, and a classic serif one. The maintainer picked the current look ("A"), so the renderer stays as built and the existing PDF claims cover it.
- 2026-10-24: The maintainer asked for a better page design: minimal and technical, not over-designed. References from Inspo: MotherDuck (uppercase monospace labels on warm-gray paper) and the Cursor changelog (system faces, thin rules, near-black ink). Kept to system fonts so the page still loads nothing from the network. Claims ISC-113 to ISC-118 added to F14; ships as v0.1.1 with the narrowed approval-prompt wording.
- 2026-10-23: Both approval-prompt fog items closed by narrowing the promise, at the maintainer's call, instead of testing each app. The README and the approvals guide now say only Claude Code asks in chat (a real `claude -p` run refused a flagged tool with "MCPTool requires permission"); every other app, Codex and Claude Desktop included, is described as using the local approval page. Safety never rested on the prompt: a gated action stays pending until approved on the page or with a passkey. Per-app chat-prompt tests move to Remaining Work.
- 2026-10-23: Docs scrub before going public. The planning docs were never committed (git ignores docs/). All 88 commits, the 13 fixture books and the remote's refs (main only; no issues, PRs or releases) were scanned for client names, employer, home paths, assistant-system names and credential patterns, with no hits. What stays by design is the maintainer's name in LICENSE and the plugin manifests, and the kkeeling/solobooks URLs.

## Learning

- 2026-10-23 | conjectured: a period's invoice draft should hold only items dated inside that period
  refuted by: a September entry recorded in October lands on no draft, ever; it would go unbilled silently
  learned: billing periods are labels, not filters; the unbilled set is what must drain
  criterion now: ISC-29's test covers a carried-over late entry and a skipped month's milestone and recurring fee

- 2026-10-23 | conjectured: showing the person the client and total, and re-checking those at approval, is enough for "approve exactly what was shown"
  refuted by: the gate audit swapped a parked draft's note, lines and terms at the same total, and the person approved the changed invoice, at passkey level too; a note carrying fake bank details reached the client unseen
  learned: what the person approves is the whole document that reaches the client, not its headline; the gate has to freeze and show everything issue would send
  criterion now: ISC-106 holds a waiting draft against edits, ISC-107 shows every line, note, terms and payment instructions in fixed wording

- 2026-10-23 | conjectured: putting the MCP requiresUserInteraction flag on any tool that has a gated field is enough to route approvals into chat
  refuted by: a real `claude -p` past-invoice import was refused "MCPTool requires permission" for `profile_set` setting only the next invoice number, so the import and the planted-instruction eval both stalled
  learned: the flag is per tool, not per call, so a tool mixing gated and ungated fields makes every call need the person
  criterion now: the payment-instructions change is its own gated tool, and a test holds that the flag sits only on tools whose every call can be gated

## Verification

- ISC-1..19, 25, 26, 28: probes as written in Test Strategy, rerun independently 2026-10-23 — `bun test` 31 pass 0 fail; scan probes ISC-2, ISC-26 proven to fail on planted violations — commits 4eb622a, 1b9ccf7, 10c21a7
- ISC-27, 29..38, 44, 45, 105: probes as written, rerun independently 2026-10-23 — `bun test` 51 pass 0 fail; issued and draft PDFs from a hand-run CLI billing viewed as rendered images — commits 463e5e5, 3eef074, 0ae1816
- ISC-63..69, 71..73, 106..109: probes as written, rerun independently 2026-10-23 — `bun test` 79 pass 0 fail; ISC-73 approved in real Brave via Interceptor (draft to issued 1001); audit swap and hidden-note attacks replayed by hand and refused — commits 60b265b, ed7e037, 51e70e2, f4bd5f6
- ISC-74: real Touch ID in Brave via Interceptor 2026-10-23 — passkey registered (Passwords), gate change click→passkey and invoice 1001 ($905.00) each stayed pending until the Touch ID assertion, then approved; `invoice get` shows issued
- ISC-81..83, 85, 86, 88..90: probes as written, rerun independently 2026-10-23 — `bun test` 93 pass 0 fail; setup and doctor rerun from the compiled binary in a clean home (Claude Code and Codex both answered with 37 tools) — commits dbb4110..a2ad0e7
- ISC-87: `bash scripts/plugin-install-check.sh` run with the real claude CLI in a throwaway home 2026-10-23 — marketplace added, plugin installed and enabled, skill in the plugin cache, `claude mcp list` shows solobooks connected; setup-written entries also listed by real `claude mcp list` (connected) and `codex mcp list` (enabled)
- ISC-76, 79: real `claude -p` runs in throwaway homes 2026-10-23 — install suite PASS in 37s (agent read INSTALL.md and the installer, ran install, setup, doctor); onboarding suite PASS in 34s, all through the solobooks MCP tools
- ISC-75, 77, 80: real agent runs in throwaway homes 2026-10-23 after commits 6b8cb07, 3e7e3d9 — Codex install PASS in 33s; past-invoice import PASS in 28s; planted-instruction import PASS in 62s with 0 pending actions created, gates and payment instructions unchanged, both plants named to the person; `bun test` 95 pass 0 fail, eval selftest 11 of 11
- ISC-20..24, 39..41, 43, 46..48, 70: probes as written, rerun independently on the merged tree 2026-10-23 — `bun test` 111 pass 0 fail, eval selftest 11 of 11 — merge 7833cf9
- ISC-42, 111, 112: probes as written, rerun independently 2026-10-23 — 1, 1 and 2 pass; full `bun test` 115 with two timeouts under load average 26 (ISC-14, ISC-24), both green rerun alone or with a longer limit; eval selftest 11 of 11 — commits 63932cb, dedcd08, 210f379
- ISC-49..61, 110: probes as written, rerun independently on the merged tree 2026-10-23 — all pass; `bash scripts/export-check.sh` 62 CSV rows and `hledger check` on 26 transactions; full `bun test` 132 of 133 with ISC-6 timing out under load, green alone in 14s; eval selftest 11 of 11; 2026 IRS mileage rates confirmed on irs.gov by the builder
- ISC-91..101: probes as written, rerun independently on merge 9579949 2026-10-23 — all pass; `bash scripts/addon-no-bun.sh` PASS with no bun or node on PATH; full `bun test` 177 pass 0 fail in 73s after the migrated-image speed-up (was 280 to 440s with timeouts); eval selftest 11 of 11; exports pass
- ISC-103, 104: probes as written, rerun independently 2026-10-23 — `-t "no entry forms"` 2 pass; `sh scripts/page-loopback-check.sh` PASS (127.0.0.1 and ::1 only); full `bun test` 184 pass 0 fail in 57s — commits 6f37cbe..328ee66
- ISC-102.1..102.4: real Brave via Interceptor (context interceptor-test) 2026-10-23 — populated books show all four panels in dollars with historical tags and overdue in red; loading skeletons with data held back; plain-words error with the file path and doctor hint when the books file is unreadable; per-panel empty hints for new books

## Remaining Work

- [x] Trademark search on "solobooks" — skipped at the maintainer's call (Decisions 2026-10-23).
- [x] Keep the planning docs (`docs/brief.md`, `docs/proposal.md`, `docs/research/`) out of the public repo or scrub them first. They name the maintainer's clients and personal tax situation — they're a release step, not a product claim.
- [ ] First real test: the maintainer's own month of client work becomes a correct invoice through the agent-time add-on — dogfood, not part of the product's definition of done.
- [ ] Grok Build and Muse Code README-prompt install tests — moved out of the v1 climb by the maintainer; they need his accounts on those agents.
- [ ] Windows `irm | iex` installer test — moved out of the v1 climb; a friend of the maintainer tests it on Windows.
- [ ] CPA review of a full year's transactions CSV and P&L with no follow-up questions — April, during tax season; can't be checked sooner.
- [ ] Optional start date on engagements, so a retainer started before its first draft carries over its earlier cycles — the step-1b carry-over covers only cycles after the first one billed.
- [x] Flip the repo public — done 2026-10-23 by the maintainer; INSTALL.md fetches anonymously (HTTP 200).
- [x] Rerun the installer check against the real GitHub Releases URL — done 2026-10-23 on release v0.1.0: the README one-liner in a bare fresh home (no bun on PATH) installed `solobooks 0.1.0`, and its hash matches the release's SHA256SUMS.
- [x] Publish the npm wrapper — done 2026-10-23: `solobooks` and the five `@solobooks/<os>-<arch>` packages at 0.1.0, built from the v0.1.0 release binaries. npm staged them until the maintainer cleared them. A fresh registry install printed `solobooks 0.1.0`, its binary hash matches the release, and MCP answered with 66 tools.
- [ ] Un-apply a client credit, so an invoice with credit applied can be voided — step 4 follow-up; today it can only be credit-noted.
- [ ] Backup retention: today every daily copy is kept, about 1,750 files over seven years. Suggested: every copy for 30 days, then the first of each month, plus every pre-upgrade copy — waits on the maintainer, since it deletes backups.
- [ ] Test which other agent apps (Codex, Claude Desktop, Cursor, ChatGPT, VS Code and the rest) show the in-chat approval prompt for a gated tool; each one that does gets named in the README.
- [ ] `backup set` and `move` are CLI-only, so an MCP-only app such as Claude Desktop can't pick a backup folder or move the books.
