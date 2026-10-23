# Sales tax, year-end and what the accountant needs

solobooks keeps the figures; the person's accountant does the taxes. Never compute income tax, pick a deduction method, decide what is taxable or deductible, or file anything. Say what the books show and suggest the person ask their accountant.

## The basis: cash

Reports count invoice income on the day the client paid, not the day it was invoiced. An invoice issued in December and paid in January is January income. Sales tax inside a payment is collected for the state, never income. Expenses count on the day they were recorded. Every report says so in `basis_note`; repeat it when you quote a figure.

## "What does my accountant need?"

For a year, run these and hand the person the files:

1. **The transactions file:** `solobooks export --year 2026 --format csv > transactions-2026.csv`. One CSV with every posted line: date, entry, memo, account, type, Schedule C line, debit, credit, source. The CLI prints the file itself, so redirect it; over MCP the file is in `text`.
2. **The year-end report:** `solobooks report yearend --year 2026`. It holds:
   - `pnl`: profit and loss, each account and the totals grouped by Schedule C line (`schedule_c`).
   - `profit_cents`: the year's profit.
   - `sales_tax`: collected, paid to the state, and owed, per tax label.
   - `mileage`: the trip log, each trip at the IRS rate for its date, with total miles and the standard mileage figure.
   - `home_office`: square feet, the office's share of the home, and the home's expenses.
   - `owner_items`: estimated tax payments (by jurisdiction), health insurance and retirement, totalled apart from the P&L.
   - `contractors`: who was paid, W-9 status, and each payment's method, with card and PayPal payments flagged `outside_1099_nec`.
3. **If they use hledger or similar:** `solobooks export --format hledger > books.journal` (passes `hledger check`).

Before handing it over, fix what the report shows as missing:

- **`pnl.not_on_schedule_c`** lists accounts with no Schedule C line. Ask the person which line each belongs on, then `account edit --id <id> --schedule-c <line>`. Don't choose for them. solobooks' own accounts already have one: invoice income and costs billed at cost are line 1, processor fees line 10.
- **Contractors with `w9_status: not_on_file`:** remind the person to collect the W-9.
- **`mileage.trips_without_rate`:** trips dated after the rate table ends. A newer solobooks has the rate.
- **No `home_office`:** ask if they work from home, and if so for the figures below.

## Setting things up during the year

| Record | Command |
|---|---|
| Schedule C line on an account | `account add ... --schedule-c 18`, or `account edit --id <id> --schedule-c 18` (`none` clears it) |
| A business trip | `mileage add --date 2026-07-01 --miles-tenths 125 --destination "Acme HQ" --purpose "Workshop"` (12.5 miles is 125); `mileage delete --id <id>` for a mistake |
| Home office for a year | `home office set --json '{"year":2026,"office_square_feet":150,"home_square_feet":1200,"expenses":[{"description":"Rent","amount_cents":2400000}]}'` (setting a year again replaces it) |
| Estimated tax payment | `owner item add --kind estimated_tax --date 2026-09-15 --amount-cents 300000 --jurisdiction federal --paid-from-account-id 1` |
| Health insurance, retirement | `owner item add --kind health_insurance` or `--kind retirement`, with `--paid-from-account-id` or `--paid-personally true` |
| A contractor | `contractor add --name "Sam Rivera" --w9-status not_on_file`; when the W-9 arrives, `contractor edit --id 1 --w9-status on_file --w9-received-on 2026-10-14` |
| Paying a contractor | `expense add ... --contractor-id 1 --payment-method ach` (ach, wire, check, cash, zelle, card, paypal, other) |

- Owner items paid from a business account are posted as an owner draw; paid personally they are only recorded. Either way they never reach the P&L. Don't record them with `expense add`.
- The mileage rate comes from a table of the IRS's published business rates by date. A trip is never posted to the books: whether to use the standard rate or actual car costs is the accountant's call.
- solobooks doesn't apply thresholds (the 1099-NEC minimum, the 50% meals limit, the home office cap). It states the figures.

## Sales tax

- A client is taxed only where the person set a rate and the line kinds it covers (see onboarding.md). Never set one on your own judgment.
- **What's owed for a period:** `report sales tax --from 2026-07-01 --to 2026-09-30`. Per tax label: `collected` (the tax inside what clients paid in the period), `paid` (payments to the state for return periods inside the range), `owed` = collected less paid. `invoiced` is the tax on invoices issued in the period, for states that want tax when invoiced rather than when paid; tell the person both figures exist and let their accountant say which their state uses.
- **After the person pays the state:** `sales tax payment add --date 2026-10-20 --amount-cents 51234 --paid-from-account-id 1 --tax-label "IL sales tax" --period-start 2026-07-01 --period-end 2026-09-30`. The label must match the invoices'. It lowers Sales tax payable and doesn't touch the P&L.
- solobooks files no return. The person files, or their accountant does.

## Profit so far

`report ytd` gives this year's profit through today as one number (`--as-of` for another day). It helps the person size estimated tax payments with their accountant; it is not the tax.
