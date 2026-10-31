# Approve on the page

By default, these wait for the person: issuing, voiding or crediting an invoice, changing the payment instructions or approval levels, recording a payment with no bank line, and undoing the bank match behind a payment. Each stays parked, not done, until they approve or reject it on the local page, and no command or tool can do that for them. The person can choose to let the agent decide instead. solobooks sends nothing, so `invoice email`, `invoice reminder` and `invoice sent` never wait.

## Sub-features

- `approve-card` shows a parked action with everything the person is agreeing to.
- `approve-yes` runs the action as shown when the person approves.
- `approve-no` leaves the books unchanged when the person rejects.
- `approve-batch` lets the person untick invoices in a batch and keep those as drafts.
- `approve-guard` gives the agent no way to approve, and refuses a guessed request.
- `approve-held` holds a waiting draft against edits, and refuses an approval when what it would do has changed.
- `approve-level` lets the person hand a kind of action to the agent, which then runs it at once.
- `approve-passkey` requires the person's passkey at passkey level.

## How to get to it (user POV)

- Open the page from the `approve_url` an agent is given, or the address `solobooks serve` printed.
- Choose `Approve` or `Reject` on a card under `Waiting for your approval`.
- Choose `Register a passkey` (`#register`), which makes passkey level possible. Never click it in a run, because it saves a real passkey.
- An agent app's own prompt can also approve when the app declares it can ask, at click level only. Declining there leaves the action waiting. No app is verified to offer this, and `control.ts mcp` declares no way to ask, so report this entry point as not verified.

## Driving it with control.ts

Preconditions:

- `control.ts up --seed billing` is ready, and `control.ts doctor` exits 0.
- Pending action 1 is the payment instructions change. Invoice 1 is a $273.12 draft.

- **Card shows, nothing happened.** Run `control.ts page --as approve-card open`. The text shows `Change the payment instructions printed on invoices?` with Current `(none)` and New `ACH to First Bank, routing 011000015, account 1234567`. Run `control.ts cli --as approve-card -- profile get`. `payment_instructions` is `null`.
- **Approve.** Run `control.ts page --as approve-yes click --selector '[data-approve="1"]'`, then `control.ts page --as approve-yes eval --main 'document.querySelector("#pending-1 .outcome").textContent'`. It reads `Approved. It's done.` Run `control.ts cli --as approve-yes -- profile get`. `payment_instructions` now holds the ACH text.
- **Agent asks to issue.** Run `control.ts cli --as approve-card -- invoice issue --id 1 --source agent:verify`. It returns `"status": "pending"`, `"pending_id": 2`, title `Issue invoice 1001 for $273.12?`, and an `approve_url` on this run's port. Run `control.ts cli --as approve-card -- invoice get --id 1`. `status` is still `draft` and `number` is `null`.
- **Everything is on the card.** Run `control.ts page --as approve-card open` and `control.ts page shot approve-card`. The card lists invoice 1001, Acme Robotics and its address, both lines, the total, the terms and the payment instructions.
- **Agent can't approve.** Run `control.ts cli --as approve-guard -- pending approve --id 2`. It exits 2 with `There is no such command`. Run `control.ts mcp --list`. It lists `pending_get` and `pending_list` and no tool that approves.
- **Guessed request refused.** Run `curl -s -X POST "$(control.ts list | bun -e 'const r=(await Bun.stdin.json()).find(r=>!r.stoppedAt);console.log(r.url)')approve" -H 'content-type: application/json' -d '{"pending_id":2,"code":"guess"}'`. It answers `ok:false` and says the approval link expired or was already used. `invoice get --id 1` is still `draft`.
- **Reject.** Run `control.ts page --as approve-no click --selector '[data-reject="2"]'`, then `control.ts page --as approve-no eval --main 'document.querySelector("#pending-2 .outcome").textContent'`. It reads `Rejected. Nothing changed.` Run `control.ts cli --as approve-no -- pending get --id 2`. `status` is `rejected` and `decided_via` is `page`. `invoice get --id 1` is still `draft`.
- **Ask again and approve.** Run `control.ts cli --as approve-yes -- invoice issue --id 1 --source agent:verify`, which returns `"pending_id": 3`. Run `control.ts page --as approve-yes open`, then `control.ts page --as approve-yes click --selector '[data-approve="3"]'`. Run `control.ts cli --as approve-yes -- invoice get --id 1`. `status` is `issued` and `number` is `1001`. Run `control.ts page --as approve-yes open` and `control.ts page shot approve-yes`. `Owed to you` reads `$273.12` and `Waiting for you` reads `0`.
- **Held and changed.** Run `control.ts down`, then start a fresh `billing` run. Run `control.ts page --as approve-held open` and `control.ts page --as approve-held click --selector '[data-approve="1"]'`, then `control.ts cli --as approve-held -- invoice issue --id 1 --source agent:verify`, which returns `"pending_id": 2`. Run `control.ts cli --as approve-held -- invoice edit --id 1 --note Changed --source agent:verify`. It exits 2 saying draft invoice 1 is waiting for approval. Run `control.ts cli --as approve-held -- profile set --address "2 Main St, Springfield, IL 62701" --source agent:verify`, then `control.ts page --as approve-held open` and `control.ts page --as approve-held click --selector '[data-approve="2"]'`. Run `control.ts page --as approve-held eval --main 'document.querySelector("#pending-2 .outcome").textContent'`. It reads `What this would do has changed since the person was asked, so reject it and ask again. Reload the page to try again.` `invoice get --id 1` is still `draft`.
- **Batch.** Run `control.ts down`, then start a fresh `billing` run. Run `control.ts page --as approve-batch open` and `control.ts page --as approve-batch click --selector '[data-approve="1"]'`. Then run `control.ts cli --as approve-batch -- client add --name "Beta LLC" --email ap@beta.example --address "9 Elm Rd, Austin, TX 78701" --source agent:verify`, `control.ts cli --as approve-batch -- engagement add --client-id 2 --name Advice --rate-cents-per-hour 20000 --source agent:verify`, `control.ts cli --as approve-batch -- time add --client-id 2 --engagement-id 2 --date 2026-10-04 --minutes 60 --note Call --source agent:verify`, `control.ts cli --as approve-batch -- invoice draft --client-id 2 --period-start 2026-10-01 --period-end 2026-10-31 --source agent:verify`, and `control.ts cli --as approve-batch -- invoice issue --json '{"ids":[1,2]}' --source agent:verify`. The title is `Issue 2 invoices totalling $473.12?` and the `pending_id` is `2`. Run `control.ts page --as approve-batch open`, `control.ts page --as approve-batch click --selector 'input[data-batch="2"][value="2"]'`, and `control.ts page --as approve-batch click --selector '[data-approve="2"]'`. `invoice get --id 1` is `issued` with number `1001`. `invoice get --id 2` is still `draft`.
- **Let the agent decide.** Run `control.ts down`, then start a fresh `billing` run. Run `control.ts page --as approve-level open` and `control.ts page --as approve-level click --selector '[data-approve="1"]'`. Run `control.ts cli --as approve-level -- gate set --invoice-issue agent_decides --source agent:verify`. It returns `"level": "click"` and `"pending_id": 2`. Run `control.ts page --as approve-level open` and `control.ts page --as approve-level click --selector '[data-approve="2"]'`. Run `control.ts cli --as approve-level -- invoice issue --id 1 --source agent:verify`. It returns the invoice with `status` `issued` and `number` `1001`, and no `pending_id`. `control.ts cli --as approve-level -- pending list` is empty.
- **Passkey level.** Report this as not verified unless the person is at the keyboard. Run `control.ts down`, then start a `full` run. Run `control.ts cli --as approve-passkey -- gate set --invoice-issue passkey --source agent:verify`. It returns `"level": "passkey"` and `"pending_id": 3`, titled `Change approval levels?`. Run `control.ts page --as approve-passkey open`. The card reads `Passkey required` with `Approve with passkey`. Do not click that button, because completing it needs the person's real passkey. `Reject` needs none: run `control.ts page --as approve-passkey click --selector '[data-reject="3"]'`, then `control.ts cli --as approve-passkey -- pending get --id 3`. `status` is `rejected`.

## Gotchas

- The tick boxes report `no DOM change after click`. That warning is harmless here. The proof is which invoices were issued.
- Parking adds a row named for the operation to `history list`, so a row there doesn't prove it ran. The invoice's `status` does.
- Approving with the passkey button raises a passkey prompt, Touch ID on a Mac, on the person's screen, and registering one saves a real passkey to their machine. Neither happens without them.
- `gate set` to passkey is refused until a passkey is registered, so it can't be tried on the `billing` or `empty` seeds. The `full` seed's passkey is a software one that no browser holds.
- A card asked for after the page loaded isn't on the page until you open it again.
- Unticking every invoice in a batch is refused with `Pulling every invoice leaves nothing to issue, so reject the batch instead.` The batch stays pending.
- A card's code lasts 15 minutes and doesn't survive restarting `serve`. A stale click gets the same `expired or was already used` answer as a guessed one.
- `approve_url` follows `SOLOBOOKS_PORT`, not `serve --port`, so it can point at the wrong address (`billing-4g5`). `control.ts` sets the variable, so its runs don't show this.
- `page eval` needs `--main`. Without it, Interceptor reports that isolated eval is unavailable.
