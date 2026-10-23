# Day-to-day billing

## "Bill everyone for October"

1. `client list`, then for each client draft the period: `invoice draft --client-id <id> --period-start 2026-10-01 --period-end 2026-10-31`. A draft picks up everything unbilled dated on or before the period's end: time, milestones billable by then, recurring fees, and pass-through costs. Lines from earlier are marked `carried_over`. A client with nothing unbilled is refused with a reason; skip them and say so.
2. Show the person each draft: client, lines, total. Fix anything they want with `invoice edit` (terms, note, add or remove lines).
3. Issue them together: `invoice issue --ids <draft ids>`. That's one approval for the person, who can pull any invoice out. See approvals.md.
4. For each issued invoice: `invoice pdf --id <id>` saves the PDF in the books folder (the result has its path) and `invoice email --id <id>` gives the from, to, subject and body. Send it through the person's own mail, preferably as a draft they send themselves. Then `invoice sent --id <id>`.

## Time

`time add --client-id <id> --date <day> --minutes <n> --note "<what>"`. solobooks bills exact minutes unless the client has rounding. Time on an issued invoice is locked; unbilled time can be edited or deleted.

## Expenses

`expense add --date <day> --amount-cents <n> --vendor <who> --account-id <expense account> --paid-from-account-id <bank or card>`, with `--receipt-path <file>` to copy the receipt into the books, and `--pass-through-client-id <id>` to bill it on to a client at cost. `account list` shows the accounts.

## Fixing an issued invoice

- Wrong entirely: `invoice void --id <id> --reason "..."`. The number stays used; what it billed goes back to unbilled, so you can draft again.
- Too much: `invoice credit --invoice-id <id> --reason "..." [--amount-cents <n>]` issues a credit note against it.

Both wait for the person's approval by default.

## Overdue

`report unpaid` lists every invoice still owed, most days late first. `invoice reminder --id <id>` writes the reminder text with the unpaid balance and days late. You send it. Payments, partial or not, go through `payment add`: see money.md.

## Looking at the books

`report pnl --from 2026-01-01 --to 2026-12-31` for profit and loss, `invoice list` for invoices and what's still open (`open_cents`), `history list` for every change and who made it.
