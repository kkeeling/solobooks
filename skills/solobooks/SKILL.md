---
name: solobooks
description: Keeps the books for a US solo consultant with the local solobooks app - set up a new person, bill clients for time, fixed fees and retainers, issue invoices through the person's approval, record expenses with receipts, record client payments, reconcile bank and card statements, keep the owner's own money out of the P&L, track sales tax owed, keep the mileage log and other year-end records, hand their accountant the year, and bring in past invoices from a spreadsheet. Use when the person mentions solobooks, their books, invoicing or billing a client, unbilled time, expenses or receipts, a client paying, a bank or card statement CSV, transfers or owner draws, who owes them money, their P&L or profit, sales tax, mileage, home office, estimated taxes, contractors or 1099s, year end, what their accountant needs, or moving off a spreadsheet or another books app.
license: MIT
compatibility: Needs the solobooks app on this machine, connected with `solobooks setup` (check with `solobooks doctor`). Works through its MCP tools or its CLI.
metadata:
  version: "0.1.0"
---

# solobooks

solobooks is a small books app that runs on the person's own machine. It holds the math and the rules: a double-entry ledger, gap-free invoice numbers, and an approval gate the person controls. You do the talking, the judgment and everything outside the machine: you ask the questions, read their old spreadsheets, and send the emails. solobooks never sends anything, connects to nothing, and has no AI inside.

## How to call it

- **MCP tools** (preferred when connected): one tool per operation, such as `client_add` or `invoice_draft`. Every write needs `source`, such as `agent:claude-code`.
- **CLI**: `solobooks <noun> <verb> --field value ... --source agent:<your-name>`, or `--json '{...}'` for lists. `solobooks help` lists every command and field. Add `--dry-run` to any write to see what it would do without changing anything.
- Money is whole **cents** (`15000` is $150.00). Dates are `YYYY-MM-DD`. Rates are cents per hour.
- A refusal is one sentence plus the field to change. Fix that field and retry; don't work around it.
- Pass an `idempotency_key` when a write might be retried (bulk imports especially): repeating it is a no-op.

## The rules that matter

1. **Pending means nothing happened.** Issuing, voiding and crediting invoices, changing payment instructions (`profile payment instructions set`), recording a payment with no bank line behind it (or undoing the bank match behind one), and changing approval levels wait for the person unless they chose otherwise. When a result says `"status": "pending"`, tell the person it is waiting for their approval and has not happened. Never say an invoice was issued or sent while it is pending. Read [references/approvals.md](references/approvals.md) the first time you see one.
2. **You can't approve anything,** and no tool lets you. Don't look for one, and don't ask the person to lower the gate to save you a step. That choice is theirs, unprompted.
3. **Never decide what is taxable.** solobooks adds sales tax only where the person set a rate on a client and named the line kinds it covers. Ask them; don't guess.
4. **Issued money is locked.** Drafts can change freely. After issue, the only changes are void (a reversal) or a credit note.
5. **solobooks makes the documents; you deliver them.** `invoice pdf` and `invoice email` give you the file and the text. Send through the person's own mail (prefer leaving a draft for them to send), then record it with `invoice sent`.

## Start here

- **New person, or `profile get` shows no legal name:** run onboarding. Follow [references/onboarding.md](references/onboarding.md). It goes from install to a first draft invoice by asking for five things.
- **They have past invoices or expenses somewhere else:** follow [references/prior-data.md](references/prior-data.md).
- **A client paid, a bank or card statement, or the person's own money moving:** follow [references/money.md](references/money.md). Import the statement first, so payments are backed by the bank.
- **"Bill everyone for October" and other day-to-day work:** see [references/billing.md](references/billing.md).
- **Sales tax owed, a trip, estimated taxes, a contractor, or "what does my accountant need?":** follow [references/year-end.md](references/year-end.md).

## Quick map

| They want to | Use |
|---|---|
| Set their business details | `profile set` (name, address, EIN, email, next invoice number); payment instructions go through `profile payment instructions set` (waits for approval) |
| Add a client and how they pay | `client add`, then `engagement add` (hourly rate, milestones, or a recurring fee) |
| Log time | `time add` (client, date, minutes, note) |
| Bill a period | `invoice draft` → show it → `invoice issue` (waits for approval) |
| Send it | `invoice pdf` + `invoice email` → send → `invoice sent` |
| Record a cost | `expense add`, with `receipt_path` for the receipt file |
| Import a bank or card statement | `bank import` with the CSV's column map, then `bank list --status unmatched` |
| Record a client's payment | `payment add` (gross, fee, and the bank line it is) |
| Refund a payment, or use a client's credit | `payment refund` (full or part; the fee stays spent unless the processor returned it), `client credit apply` |
| Undo a wrong bank match | `bank unmatch` (waits for approval when the line backs a payment) |
| Move their own money | `transfer add`, `owner draw`, `owner contribute`; personal-card costs are `expense add --paid-personally true` |
| See who owes what | `report unpaid` |
| See how they're doing | `report pnl` (cash basis, by Schedule C line), `report ytd`, `invoice list` |
| Sales tax owed, and paying the state | `report sales tax`, `sales tax payment add` |
| Year-end records | `mileage add`, `home office set`, `owner item add`, `contractor add` |
| Give the accountant the year | `export --year <y> --format csv` plus `report yearend --year <y>` |
| Bring in old invoices | `invoice import` |
| See what's waiting | `pending list` |

solobooks keeps books in US dollars, for one US business, on one machine. It isn't tax or accounting advice, and you shouldn't present its numbers as such.
