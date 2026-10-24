# Approvals: the gate

The person decides how much you may do alone. For each gated action they pick a level:

| Level | What happens when you ask |
|---|---|
| `agent_decides` | It runs at once. |
| `click` (the default) | It waits until the person approves it in their agent app's prompt, or on the approval page. |
| `passkey` | It waits until they approve it with their passkey (Touch ID and the like) on the approval page. |

Gated actions: issuing invoices, voiding invoices and credit notes, issuing credit notes, changing the payment instructions printed on invoices (`profile payment instructions set`), and recording an invoice payment with no imported bank line behind it (`payment_unmatched`; give `bank_line_id` and it isn't gated). Undoing the bank match behind a payment (`bank unmatch` on that line) is the same `payment_unmatched` action, since it leaves the payment with no bank line; undoing any other match isn't gated. Everything else `profile set` changes runs at once. Changing a level is itself always gated. `gate list` shows the current levels.

## When a result is pending

You'll get something like:

```json
{ "status": "pending", "pending_id": 3, "level": "click", "title": "Issue invoice 1043 for $1,350.00?",
  "approve_url": "http://localhost:7317/#pending-3", "message": "Nothing has happened yet: ..." }
```

- **Say it plainly:** "Invoice 1043 for $1,350.00 is waiting for your approval. It hasn't been issued yet."
- **Don't claim it happened.** No "I've issued your invoice", no PDF or email for it, no `invoice sent`, until it's approved.
- **Where they approve:** an agent app that supports MCP elicitation can show the approval right in the chat, inside the same tool call. No app has been seen doing it yet (Claude Code 2.1 asks only whether to run the tool, which is not the approval), so expect the page. If the person approved there, the result already says `"status": "approved"` with the outcome. Otherwise they approve on the local approval page: start it with `solobooks serve` (it keeps running; start it in the background if you can) and give them the `approve_url`. Passkey level always uses the page.
- **Checking back:** `pending get --id <pending_id>` shows `pending`, `approved` (with the result) or `rejected`. Look before you continue.
- **Rejected** means the person said no. Ask what they'd like changed; don't resubmit the same thing.
- **While a draft waits,** it can't be edited. If something needs to change, the person rejects it, you edit the draft, and you ask again.

## Batches

To issue several drafts, pass them all at once (`invoice issue --ids 4,5,6`). The person gets one approval listing every invoice, and can untick any to keep it a draft. Report exactly what came back: which were issued, with numbers, and which stayed drafts.

## Things you never do

- Look for a way to approve, or use another command to get the same effect (for example, bringing in a new invoice as a past one).
- Suggest lowering a level so you can go faster. If the person asks to change one on their own, run `gate set`; that request waits for their approval too.
- Put payment instructions in an invoice note to get around their gated change.
- Make or edit a bank file so a payment has a line to point at. The bank line has to come from the bank.
