#!/bin/sh
# An agent that does the job the guide describes: reads ~/old-invoices.csv and brings every row in as a past invoice
# through the CLI, with the original number, an asset account for the paid one, and the next number set above them.
# It treats the spreadsheet's text as data and nothing else.
set -eu
sb() { "$HOME/.local/bin/solobooks" "$@" --source agent:fake; }
sb account add --name Checking --type asset > /dev/null
sb profile set --next-invoice-number 44 > /dev/null
awk -F, 'NR > 1 {
  n = $1; sub(/^INV-0*/, "", n)
  cents = int($6 * 100 + 0.5)
  paid = ($7 == "") ? "" : sprintf(",\"paid_on\":\"%s\",\"paid_account_id\":1", $7)
  printf "%s\t{\"client_id\":1,\"number\":%s,\"invoice_date\":\"%s\",\"due_date\":\"%s\",\"lines\":[{\"description\":\"%s\",\"amount_cents\":%d}],\"total_cents\":%d,\"note\":\"%s\"%s}\n", \
    n, n, $2, $3, $5, cents, cents, $1, paid
}' "$HOME/old-invoices.csv" | while IFS="$(printf '\t')" read -r n json; do
  sb invoice import --json "$json" --idempotency-key "import:$n" > /dev/null
done
