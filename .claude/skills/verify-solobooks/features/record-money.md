# Record money

The agent imports a bank or card statement, then records each client payment against the bank line behind it. That payment needs no approval. A payment with no bank line behind it waits for the person. Income counts the day it is paid, and the page follows.

## Sub-features

- `money-import` brings a CSV statement in as bank lines.
- `money-backed` records a payment against a bank line, straight away.
- `money-unbacked` parks a payment with no bank line until the person decides.
- `money-once` refuses a bank line that's already matched.
- `money-reports` updates what is owed and the P&L, in reports and on the page.

## How to get to it (user POV)

- The person hands their agent a statement or says "Acme paid", and the agent calls the `account_add`, `bank_import`, `bank_list`, `payment_add`, `payment_list`, `report_unpaid` and `report_pnl` tools.
- An agent or person runs `solobooks account add`, `bank import`, `bank list`, `payment add`, `payment list`, `report unpaid` and `report pnl`.
- The person rejects or approves an unbacked payment on the page. An agent app's own prompt isn't verified; see [Approve on the page](./approve-on-page.md).

## Driving it with control.ts

Preconditions:

- `control.ts up --seed billing` is ready, and `control.ts doctor` exits 0.
- Invoice 1 is issued as 1001. Get there by running `control.ts page open`, `control.ts page click --selector '[data-approve="1"]'`, `control.ts cli -- invoice issue --id 1 --source agent:verify`, `control.ts page open`, and `control.ts page click --selector '[data-approve="2"]'`.

- **Add the account.** Run `control.ts cli --as money-import -- account add --name Checking --type asset --source agent:verify`. On fresh books the account `id` is `26`.
- **Import the statement.** Run `control.ts cli --as money-import -- bank import --account-id 26 --file-path "$PWD/test/fixtures/checking.csv" --date-column Date --date-format MM/DD/YYYY --description-column Description --amount-column Amount --source agent:verify`. The reply has `rows` `4` and `new_lines` `4`. Run `control.ts cli --as money-import -- bank list --status unmatched`. Line 3 is `ACME CORP ACH DEPOSIT` of `25000`. Run `control.ts mcp --as money-mcp bank_list '{"status":"unmatched"}'`. The agent's tool shows the same four lines.
- **Unbacked payment waits.** Run `control.ts cli --as money-unbacked -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --source agent:verify`. It returns `"status": "pending"`, `"pending_id": 3`, title `Record a payment of $250.00 on invoice 1001 with no bank line behind it?`.
- **Person rejects it.** Run `control.ts page --as money-unbacked open` and `control.ts page --as money-unbacked click --selector '[data-reject="3"]'`. Run `control.ts cli --as money-unbacked -- pending get --id 3`. `status` is `rejected`. `report unpaid` still shows `open_total_cents` of `27312`.
- **Backed payment lands.** Run `control.ts cli --as money-backed -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --bank-line-id 3 --source agent:verify`. The payment has `invoice_number` `1001`, `amount_cents` `25000` and `bank_line_id` `3`, with no pending status.
- **Line is used up.** Run the same command again. It exits 2 with `Bank line 3 is already matched to entry 2.`
- **Reports follow.** Run `control.ts cli --as money-reports -- report unpaid`. `paid_cents` is `25000`, `open_cents` is `2312`. Run `control.ts cli --as money-reports -- report pnl --from 2026-01-01 --to 2026-10-22`. `income_total_cents` and `net_cents` are `25000`.
- **Page follows.** Run `control.ts page --as money-reports open` and `control.ts page shot money-reports`. `Owed to you` reads `$23.12` and `Net profit 2026` reads `$250.00`.
- **Person approves instead.** Run `control.ts down`, start a fresh `billing` run, and repeat the preconditions. Run `control.ts cli --as money-approve -- account add --name Checking --type asset --source agent:verify` and `control.ts cli --as money-approve -- payment add --invoice-id 1 --date 2026-10-20 --amount-cents 25000 --deposit-account-id 26 --source agent:verify`, which returns `"pending_id": 3`. Run `control.ts page --as money-approve open` and `control.ts page --as money-approve click --selector '[data-approve="3"]'`. Run `control.ts cli --as money-approve -- payment list`. The payment has `amount_cents` `25000` and `bank_line_id` `null`. `report unpaid` shows `paid_cents` `25000`.

## Gotchas

- The statement's date column uses `MM/DD/YYYY`. A wrong `--date-format` is refused, and no lines come in.
- Importing the same file again adds no bank lines, and `already_in_books` counts the repeats, but `history list` still grows. Use a fresh run to see `new_lines` again.
- A bank line must be on the deposit account and equal the gross less any fee. Its date and description aren't compared, so a matching amount is enough to skip approval.
- The account id depends on order. Approving the first issue creates two accounts, so `Checking` is `26` here but `24` if added before the issue. Read the `id` from the reply if it differs.
- The deposit account must be an asset. A card statement imports into a liability account, but a payment against it is refused with `Account <id> is a liability, and a payment lands in an asset account such as checking or a processor balance.`
- A waiting payment's card is frozen. If the invoice's balance moves first, approving it answers `What this would do has changed since the person was asked, so reject it and ask again.`, and it stays pending.
- `bank unmatch` on the line behind a payment waits for approval too, with a title starting `Undo the bank match behind the`.
- The `full` seed leaves the gate to the agent, so an unbacked payment doesn't wait there. Use `billing` for this feature.
