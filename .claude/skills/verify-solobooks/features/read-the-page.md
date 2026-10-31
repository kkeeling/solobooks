# Read the page

The local page gives the person a look at their books without asking the agent: four summary figures, anything waiting for approval, then invoices, unpaid, the year's profit and loss, and recent changes. It explains itself when empty, while loading, and when the books can't be read. Nothing on it changes the books except the approval buttons and `Register a passkey`.

## Sub-features

- `page-populated` shows figures and all four panels from real books.
- `page-empty` gives each panel a plain hint on new books.
- `page-loading` shows a loading state while the data is on its way.
- `page-unreadable` says what's wrong and what to do when the books can't be read, and recovers on reload.

## How to get to it (user POV)

- Run `solobooks serve` and open the address it prints, `http://localhost:7317/` by default. A verification run uses its own port.

## Driving it with control.ts

Preconditions:

- `control.ts doctor` exits 0 on the run named in each bullet.
- Each state below uses its own run. Run `control.ts down` between them.

- **Populated.** Start `control.ts up --seed full`. Run `control.ts page --as page-populated open --full`. `Owed to you` reads `$569.37`, `Overdue` reads `$0.00`, `Net profit 2026` reads `$3,563.56`, and `Waiting for you` reads `1`. `Invoices` lists invoices in dollars, most recently entered first, so past invoice `900`, dated `Sep 1, 2026`, sits among the October ones. `Recent changes` shows 10 rows, while its heading counts them all. Run `control.ts page shot page-populated` and look at it. Run `control.ts cli --as page-populated -- report unpaid`. `open_total_cents` is `56937`, matching the page. The `Register a passkey` button is absent because the seed registered one.
- **Empty.** Start `control.ts up --seed empty`. Run `control.ts page --as page-empty open`. Every figure reads `$0.00` or `0`. The text includes `Nothing is waiting for approval.`, `No invoices yet.`, `Nothing is owed yet.`, `Nothing earned or spent this year yet.`, and `No changes yet.`. The `Register a passkey` button is there. Run `control.ts page shot page-empty`. Run `control.ts cli --as page-empty -- history list`. It has no rows, so looking at the page wrote nothing.
- **Loading.** Start `control.ts up --seed billing --hold-data-ms 8000`. Run `control.ts page --as page-loading open --no-wait`, wait 2 seconds, then run `control.ts page --as page-loading text` and `control.ts page shot page-loading`. The text includes `Loading invoices…` and `Loading what is owed…`. `Owed to you`, `Overdue` and `Net profit` read `—`, while `Waiting for you` reads `1` because it doesn't wait on the held data. After 8 more seconds, `control.ts page --as page-loading text` has no `Loading` line and shows `Draft 1`.
- **Unreadable.** Start `control.ts up --seed billing`, using the `books` folder it prints as `$BOOKS`. Run `mv "$BOOKS/solobooks.sqlite" "$BOOKS/solobooks.sqlite.away"`, then `control.ts page --as page-unreadable open` and `control.ts page shot page-unreadable`. The alert reads `solobooks can't read the books file at ... (the file is not there).` and names `solobooks doctor`. Figures read `—`, and the panels read `Can't show invoices while the books can't be read.` and the like. Run `mv "$BOOKS/solobooks.sqlite.away" "$BOOKS/solobooks.sqlite"` and `control.ts page --as page-unreadable open`. The figures and panels return.

## Gotchas

- `page open` waits for the page to settle, so it never shows the loading state. Use `--no-wait` with `--hold-data-ms`.
- `up` waits out the hold before it reports ready, so a long hold makes `up` that much slower.
- The page follows the browser's light or dark setting. A dark screenshot is expected when the test profile is dark.
- `Recent changes` times show in the machine's local time, while the pinned clock is UTC. On a US Eastern machine `12:00` UTC reads `8:00 AM`.
- The `full` seed's figures come from the shared test scenario. If `test/support/scenario.ts` changes, these figures change with it, and the page must still match `report unpaid`.
- `solobooks serve` refuses to start when the books file is already gone, exiting 2 with `There are no books in <folder> yet, so there is nothing to approve.` The unreadable alert appears only when the file goes missing after `serve` started.
- Don't click a card while the books file is moved away. The click creates blank books, and the next load shows `$0.00` and `No invoices yet.` with no alert (`billing-3jg`). Moving the real file back replaces them.
- If the server stops while a tab is loading, the alert reads `This page can't reach solobooks, so start it again with solobooks serve and reload this page.` The panels still blame the books (`billing-4n6`).
- Restore the moved books file before `down`, or `books-final/` keeps it as `solobooks.sqlite.away`.
