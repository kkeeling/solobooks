# Day-to-day billing

## "Bill everyone for October"

1. `client list`, then for each client draft the period: `invoice draft --client-id <id> --period-start 2026-10-01 --period-end 2026-10-31`. A draft picks up everything unbilled dated on or before the period's end: time, milestones billable by then, recurring fees, and waiting charges (costs billed back to the client). Lines from earlier are marked `carried_over`. A client with nothing unbilled is refused with a reason; skip them and say so.
2. Show the person each draft: client, lines, total. Fix anything they want with `invoice edit` (terms, note, add or remove lines).
3. Issue them together: `invoice issue --ids <draft ids>`. That's one approval for the person, who can pull any invoice out. See approvals.md.
4. For each issued invoice: `invoice pdf --id <id>` saves the PDF in the books folder (the result has its path) and `invoice email --id <id>` gives the from, to, subject and body. Send it through the person's own mail, preferably as a draft they send themselves. Then `invoice sent --id <id>`.

## Time

`time add --client-id <id> --date <day> --minutes <n> --note "<what>"`. solobooks bills exact minutes unless the client has rounding. Time on an issued invoice is locked; unbilled time can be edited or deleted.

## Expenses

`expense add --date <day> --amount-cents <n> --vendor <who> --account-id <expense account> --paid-from-account-id <bank or card>`, with `--receipt-path <file>` to copy the receipt into the books. `account list` shows the accounts. Recording a cost never needs a billing choice; `--pass-through-client-id <id>` is a shortcut that bills the whole cost on to one client.

## Billing costs back to a client

Money spent on a client's behalf, such as API tokens their app used, is billed back at cost with a charge. The client's next draft picks up every waiting charge dated on or before its period end, as a pass-through line reading the charge's line text, booked to Reimbursed expense income.

- `charge add --client-id <id> --date <day> --amount-cents <n> --line-text "OpenAI API usage, Oct 2026"`. Date it to the last day of the usage it bills. Keep the line text short and plain: the client reads it.
- Add `--reference "openai:<key name>:2026-10"` naming exactly what you billed. A second charge with the same reference for that client is refused, so a monthly rerun can't bill the same usage twice.
- Add `--evidence-path <file>` for what the amount came from, such as the provider's usage export for that key; it is copied into the books.
- A charge needs no expense. Token usage usually matches no single card charge, because the card is charged at each top-up. When a cost did come out of one recorded expense, name it with `--expense-id`: `expense list --vendor openai --from <day> --to <day> --uncharged true` finds it, and the charges on one expense can't add up to more than it.
- `charge list --unbilled true` shows what each client has waiting. `charge edit` and `charge delete` work until the invoice billing it is issued; voiding that invoice puts its charges back in line. If a charge was wrong, delete it after the void and it won't come back; `charge edit --unlink-expense true` or `--clear-reference true` removes those links.
- solobooks bills at cost only. Don't add a markup to the amount.

## Fixing an issued invoice

- Wrong entirely: `invoice void --id <id> --reason "..."`. The number stays used; what it billed goes back to unbilled, so you can draft again.
- Too much: `invoice credit --invoice-id <id> --reason "..." [--amount-cents <n>]` issues a credit note against it.

Both wait for the person's approval by default.

## Overdue

`report unpaid` lists every invoice still owed, most days late first. `invoice reminder --id <id>` writes the reminder text with the unpaid balance and days late. You send it. Payments, partial or not, go through `payment add`: see money.md.

## Looking at the books

`report pnl --from 2026-01-01 --to 2026-12-31` for profit and loss, `invoice list` for invoices and what's still open (`open_cents`), `history list` for every change and who made it.
