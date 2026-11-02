# Record money

The agent imports a bank or card statement, then records each client payment against the bank line behind it. That payment needs no approval. A payment with no bank line behind it waits for the person. Income counts the day it is paid, and the page follows.

## Sub-features

- `money-import` brings a CSV statement in as bank lines.
- `money-backed` records a payment against a bank line, straight away.
- `money-unbacked` parks a payment with no bank line until the person decides.
- `money-once` refuses a bank line that's already matched.
- `money-reports` updates what is owed and the P&L, in reports and on the page.
- `money-mcp` shows the agent the same bank lines through its tool.
- `money-approve` records a parked payment once the person approves it.
- `money-credit` holds an overpayment as credit, applies it to the next invoice, and takes it back.

## How to get to it (user POV)

- The person hands their agent a statement or says "Acme paid", and the agent calls the `account_add`, `bank_import`, `bank_list`, `payment_add`, `payment_list`, `client_credits`, `client_credit_apply`, `client_credit_unapply`, `report_unpaid` and `report_pnl` tools.
- An agent or person runs `solobooks account add`, `bank import`, `bank list`, `payment add`, `payment list`, `client credits`, `client credit apply`, `client credit unapply`, `report unpaid` and `report pnl`.
- The person rejects or approves an unbacked payment on the page. An agent app's own prompt isn't verified; see [Approve on the page](./approve-on-page.md).

## Driving it with control.ts

Preconditions:

- `control.ts up --seed billing` is ready, and `control.ts doctor` exits 0.
- Invoice 1 is issued as 1001. Get there by running `control.ts page open`, `control.ts page click --selector '[data-approve="1"]'`, `control.ts cli -- invoice issue --id 1 --source agent:verify`, `control.ts page open`, and `control.ts page click --selector '[data-approve="2"]'`.

- **Add the account.** Run `control.ts cli --as money-import -- account add --name Checking --type asset --source agent:verify`. On fresh books the account `id` is `26`.
- **Import the statement.** Run `control.ts cli --as money-import -- bank import --account-id 26 --file-path "$PWD/test/fixtures/checking.csv" --date-column Date --date-format MM/DD/YYYY --description-column Description --amount-column Amount --source agent:verify`. The reply's `import` has `rows` `4` and `new_lines` `4`. Run `control.ts cli --as money-import -- bank list --status unmatched`. Line 3 is `ACME CORP ACH DEPOSIT` of `25000`. Run `control.ts mcp --as money-mcp bank_list '{"status":"unmatched"}'`. The agent's tool shows the same four lines.
- **Unbacked payment waits.** Run `control.ts cli --as money-unbacked -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --source agent:verify`. It returns `"status": "pending"`, `"pending_id": 3`, title `Record a payment of $250.00 on invoice 1001 with no bank line behind it?`.
- **Person rejects it.** Run `control.ts page --as money-unbacked open` and `control.ts page --as money-unbacked click --selector '[data-reject="3"]'`. Run `control.ts cli --as money-unbacked -- pending get --id 3`. `status` is `rejected`. `report unpaid` still shows `open_total_cents` of `27312`.
- **Backed payment lands.** Run `control.ts cli --as money-backed -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --bank-line-id 3 --source agent:verify`. The payment has `invoice_number` `1001`, `amount_cents` `25000` and `bank_line_id` `3`, with no pending status.
- **Line is used up.** Run the same command again with `--as money-once`. It exits 2 with `Bank line 3 is already matched to entry 2.`
- **Reports follow.** Run `control.ts cli --as money-reports -- report unpaid`. `paid_cents` is `25000`, `open_cents` is `2312`. Run `control.ts cli --as money-reports -- report pnl --from 2026-01-01 --to 2026-10-22`. `income_total_cents` and `net_cents` are `25000`.
- **Page follows.** Run `control.ts page --as money-reports open` and `control.ts page shot money-reports`. `Owed to you` reads `$23.12` and `Net profit 2026` reads `$250.00`.
- **Person approves instead.** Run `control.ts down`, start a fresh `billing` run, and repeat the preconditions. Run `control.ts cli --as money-approve -- account add --name Checking --type asset --source agent:verify` and `control.ts cli --as money-approve -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --source agent:verify`, which returns `"pending_id": 3`. Run `control.ts page --as money-approve open` and `control.ts page --as money-approve click --selector '[data-approve="3"]'`. Run `control.ts cli --as money-approve -- payment list`. The payment has `amount_cents` `25000` and `bank_line_id` `null`. `report unpaid` shows `paid_cents` `25000`.
- **Credit, then taken back.** On a fresh `billing` run with invoice 1 issued and `Checking` added as account 26, run `control.ts cli --as money-credit -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 30000 --deposit-account-id 26 --source agent:verify`, then approve pending 3 on the page. `client credits --client-id 1` holds `2688`. Add an hour with `time add --client-id 1 --date 2026-10-21 --minutes 60 --note "More work" --source agent:verify`, draft invoice 2 with `invoice draft --client-id 1 --period-start 2026-10-01 --period-end 2026-10-31 --source agent:verify`, ask to issue it with `invoice issue --id 2 --source agent:verify`, and approve pending 4. Run `client credit apply --client-id 1 --invoice-id 2 --date 2026-10-22 --source agent:verify`. `invoice_open_cents` is `12312`. `invoice email --id 2` asks for `$123.12`, and the PDF shows `Paid or credited -$26.88` and `Total due $123.12`. `invoice void --id 2 --reason "Billed in error" --source agent:verify` exits 2 naming `client credit unapply --application-id 1 --date 2026-10-22`. Run `control.ts mcp --as money-credit client_credit_unapply '{"application_id":1,"date":"2026-10-22","source":"agent:verify"}'`. `invoice_open_cents` is `15000` and `client_balance_cents` is `2688`. Doing it again is refused with `already taken back`. The void then parks, and approving it on the page leaves invoice 2 `void`.

## Gotchas

- The statement's date column uses `MM/DD/YYYY`. A wrong `--date-format` is refused, and no lines come in.
- Importing the same file again adds no bank lines, and `already_in_books` counts the repeats, but `history list` still grows. Use a fresh run to see `new_lines` again.
- A bank line must be on the deposit account and equal the gross less any fee. Its description isn't compared, and neither is its date unless the payment is dated after today, so a matching amount is enough to skip approval.
- The account id depends on order. Approving the first issue creates two accounts, so `Checking` is `26` here but `24` if added before the issue. Read the `id` from the reply if it differs.
- The deposit account must be an asset. A card statement imports into a liability account, but a payment against it is refused with `Account <id> is a liability, and a payment lands in an asset account such as checking or a processor balance.`
- A waiting payment's card is frozen. If the invoice's balance moves first, approving it answers `What this would do has changed since you were asked, so reject it and ask again.`, and it stays pending.
- A payment dated after today is refused, whether it has a bank line or not, unless it names a bank line with that same date. Credit applied with a date after today is refused too, with no bank line exception: `The credit is dated <date>, which is after today, <today>, so date it today or earlier.` A date before the invoice's date is allowed.
- `payment add --bank-line-id` refuses when the invoice already has a same-amount payment into that account with no bank line and not fully refunded, because one deposit could count twice. The refusal names `bank match --line-id <line> --entry-id <entry>`, and that command attaches the line to the earlier payment with nothing new recorded (`payment list` shows `bank_line_id` set, `report unpaid` is unchanged). For a real second payment of the same amount, it names the route: record it with no bank line, get it approved, then `bank match`. To see this refusal, import the statement before recording the payment. Importing afterwards matches the line to that payment on its own, so `--bank-line-id` answers `already matched` instead.
- A second same-amount payment with no bank line isn't refused. Its card shows an `Earlier payment` row saying to check it isn't the same money.
- The invoice's email and PDF ask for what is still owed, and say paid in full when nothing is. They read as they always did when nothing has been settled.
- `bank unmatch` on the line behind a payment waits for approval too, with a title starting `Undo the bank match behind the`.
- The `full` seed leaves the gate to the agent, so an unbacked payment doesn't wait there. Use `billing` for this feature.
