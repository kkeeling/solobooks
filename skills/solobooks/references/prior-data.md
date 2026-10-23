# Bringing in prior data

solobooks has no importers for other apps. You bring old data in through its normal tools, from whatever the person has: a spreadsheet or CSV export, another app's own export, API or CLI, or a folder of PDFs you read.

## Past invoices: `invoice import`

A past invoice is one that was already sent before solobooks. It comes in as **historical**: it keeps its original number, posts to the books (owed from its invoice date until paid; the P&L counts it as income on the day it was paid), and never waits for approval, because nothing about it reaches a client now. In return:

- It must be dated **before today**. Anything dated today or later is a new invoice: draft it and issue it.
- Its number must be a whole number **below the next number solobooks will issue**. Set `next_invoice_number` above the highest old number first (`profile set --next-invoice-number <highest + 1>`).
- solobooks makes **no PDF, email or reminder** for it, and it shows `"historical": true` everywhere invoices are listed.

Never use `invoice import` for an invoice that hasn't gone out. If the person wants to send something, it goes through draft and issue, and their approval.

### Steps for a spreadsheet

1. Read the whole sheet first. Summarize for the person what you found: how many invoices, the date range, the number range, clients, total billed, how many are unpaid. Ask about anything odd (blank numbers, duplicate numbers, credits, partial payments).
2. Add each client that isn't in solobooks yet (`client list`, then `client add`), with their address and email if the sheet has them.
3. If any were paid, make sure there's an asset account for the money to land in: `account list`, or `account add --name Checking --type asset`.
4. Set the next invoice number above the highest old one.
5. Dry-run one row, show the person the result, then bring in every row. Use one `idempotency_key` per row, such as `import:<number>`, so a retry never doubles anything:

```sh
solobooks invoice import --json '{"client_id":1,"number":1042,"invoice_date":"2026-09-01","due_date":"2026-10-01",
  "lines":[{"description":"August consulting","amount_cents":360000}],"total_cents":360000,
  "paid_on":"2026-09-20","paid_account_id":1}' --idempotency-key import:1042 --source agent:<you>
```

6. Check the totals against the sheet with `report pnl` and `invoice list`, and tell the person what came in.

### Fields worth knowing

- `lines`: the amounts before tax. If the sheet has only a total, use one line.
- `tax_rate_ppm` and `tax_label`: only if the old invoice charged sales tax. The tax is booked as owed to the state, not as income.
- `total_cents`: the total the old invoice shows. Always pass it when you have it: solobooks refuses the row if the lines and tax don't add up to it, which catches misread cells.
- `paid_on` and `paid_account_id`: only for invoices paid in full. Leave both off for unpaid ones; they stay owed. Partial payments aren't supported for past invoices yet, so bring those in unpaid and tell the person.
- Numbers like `INV-0042`: use the whole number (42) and keep the original text in `note`.

## Past expenses

Use `expense add` with the original date, the right expense account and the account it was paid from, plus `receipt_path` when there's a receipt file. Expenses never wait for approval.

## Starting mid-year

Same moves: bring in this year's past invoices and expenses, whichever the person has. If they only have totals, ask what they'd like; don't invent per-invoice detail.
