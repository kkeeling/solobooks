# Bill a client

An agent turns logged time and costs into a draft invoice and asks to issue it. Once the person approves, it gets the numbered PDF and the email text, and records the invoice as sent. solobooks sends nothing itself.

## Sub-features

- `bill-draft` builds a draft from unbilled time and charges.
- `bill-dry` previews a write without changing the books.
- `bill-issue` numbers the invoice only after the person's approval, unless they have let the agent decide.
- `bill-docs` produces the client's PDF and the email text.
- `bill-sent` records delivery, and an issued invoice can't be issued again.
- `bill-mcp` does the same work through the MCP tools an agent app uses.

## How to get to it (user POV)

- The person tells their agent "bill Acme for October", and the agent calls the `engagement_add`, `time_add`, `charge_add`, `invoice_draft`, `invoice_issue`, `invoice_pdf`, `invoice_email` and `invoice_sent` tools.
- An agent or person runs `solobooks engagement add`, `time add`, `charge add`, `invoice draft`, `invoice issue`, `invoice pdf`, `invoice email` and `invoice sent`.

## Driving it with control.ts

Preconditions:

- `control.ts up --seed billing` is ready, and `control.ts doctor` exits 0.
- Draft invoice 1 exists for client 1. Payment instructions wait as pending 1.

- **Draft reads right.** Run `control.ts cli --as bill-draft -- invoice get --id 1`. `status` is `draft`, with a `time` line `2026-10-03 API design (90 min at $150.00/hr)` of `22500`, a `pass_through` line `OpenAI API usage, Oct 2026` of `4812`, and `total_cents` of `27312`. Run `control.ts cli --as bill-draft -- invoice draft --client-id 1 --period-start 2026-10-01 --period-end 2026-10-31 --source agent:verify`. It exits 2 with `Nothing unbilled for this client is dated on or before period_end, so there is nothing to draft.`
- **Dry run writes nothing.** Run `control.ts cli --as bill-dry -- history list` and note the row count. Run `control.ts cli --as bill-dry -- client add --name "Dry Run Co" --source agent:verify --dry-run`. The reply has `dry_run: true`. Run `control.ts cli --as bill-dry -- client list`. `Dry Run Co` isn't there, and `history list` has the same count.
- **Approve the instructions.** Run `control.ts page --as bill-issue open` and `control.ts page --as bill-issue click --selector '[data-approve="1"]'`.
- **Issue through MCP.** Run `control.ts mcp --as bill-mcp invoice_issue '{"id":1,"source":"agent:verify"}'`. It returns `"status":"pending"` with `"pending_id":2` and title `Issue invoice 1001 for $273.12?`. Run `control.ts cli --as bill-mcp -- invoice get --id 1`. It is still `draft`.
- **Person approves.** Run `control.ts page --as bill-issue open` and `control.ts page --as bill-issue click --selector '[data-approve="2"]'`. Run `control.ts mcp --as bill-mcp invoice_get '{"id":1}'`. `status` is `issued`, `number` is `1001`, `invoice_date` is `2026-10-22`, and `due_date` is `2026-11-21`. Run `control.ts page --as bill-issue open`. The invoice reads `Issued, not sent`.
- **PDF.** Run `control.ts cli --as bill-docs -- invoice pdf --id 1`. It returns `"file": "invoices/1001.pdf"` with its `sha256` and `bytes`. After `control.ts down`, read `.verify/evidence/<run>/books-final/invoices/1001.pdf`. It shows the business, EIN, Acme Robotics, both lines, `Total due $273.12` and the ACH text.
- **Email text.** Run `control.ts cli --as bill-docs -- invoice email --id 1`. It returns `from` `jane@example.com`, `to` `ap@acme.example`, subject `Invoice 1001 from Jane Doe Consulting LLC: $273.12 due November 21, 2026`, and `attachment` `invoices/1001.pdf`.
- **Recorded sent.** Run `control.ts cli --as bill-sent -- invoice sent --id 1 --source agent:verify`. `status` is `sent`. Run `control.ts page --as bill-sent open`. The invoice reads `Sent`.
- **Locked after issue.** Run `control.ts cli --as bill-sent -- invoice issue --id 1 --source agent:verify`. It exits 2 with `Invoice 1001 is sent, so it can't be issued again; void or credit it instead.`

## Gotchas

- `invoice issue` is parked even while the payment instructions are still waiting, so approve those first, as the recipe does.
- Issuing refuses when the profile lacks a legal name, address or EIN. The `billing` seed sets all three. An `empty` run has no draft to issue, so it refuses earlier with `There is no invoice or credit note with id 1.`
- Issuing also refuses a client with no address, with `Set client 2's billing address with client edit before issuing an invoice.`
- Time logged for a client with no engagement has no rate. `invoice draft` refuses with `Time entry 2 has no hourly rate, so give it the engagement_id of an hourly engagement.` until the client has an hourly engagement.
- A draft can also carry manual lines through `--json '{"lines":[{"description":"Setup","amount_cents":5000}]}'`, which gets past the `Nothing unbilled` refusal.
- A draft has a PDF too: `invoice pdf --id 1` before approval saves `invoices/draft-1.pdf`. Only the numbered file proves the issue.
- `invoice pdf` returns a path relative to the books folder. The scratch folder is gone after `down`, so read the copy under `books-final/`.
- Output past 64 KB is cut when the real `solobooks` writes to a pipe (kkeeling/solobooks#1). `control.ts` captures it to files and passes all of it on, so a pipe after `control.ts cli` is safe. A pipe after a bare `solobooks` isn't.
- The clock is pinned, so dates in the output are the run's, not today's. Pass `--now` on `up` when a date matters.
