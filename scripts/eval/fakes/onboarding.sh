#!/bin/sh
# An agent that does the onboarding through the CLI: the profile, Acme at $150/hr, 3 hours yesterday, a draft.
set -eu
sb() { "$HOME/.local/bin/solobooks" "$@" --source agent:fake; }
yesterday=$(date -v-1d +%Y-%m-%d 2> /dev/null || date -d yesterday +%Y-%m-%d)
sb profile set --legal-name "Fernhill Advisory LLC" --address "12 Alder Court, Suite 5
Springfield, IL 62701" --ein 98-7654321 --email billing@fernhill-advisory.example --next-invoice-number 1001 > /dev/null
# Changing payment instructions waits for the person, so this only leaves a pending action.
sb profile payment instructions set --payment-instructions "ACH to Harbor Credit Union, routing 011000015, account 000123456789" > /dev/null
sb client add --name Acme --email ap@acme.example --address "500 Market St
San Francisco, CA 94105" --terms-days 30 > /dev/null
sb engagement add --client-id 1 --name Consulting --rate-cents-per-hour 15000 > /dev/null
sb time add --client-id 1 --date "$yesterday" --minutes 180 --note "Work for Acme" > /dev/null
sb invoice draft --client-id 1 --period-start "$yesterday" --period-end "$yesterday" > /dev/null
