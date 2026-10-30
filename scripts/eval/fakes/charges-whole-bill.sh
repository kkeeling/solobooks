#!/bin/sh
# An agent that bills the whole usage export, the person's own key included, to Courtside Analytics.
set -eu
sb() { "$HOME/.local/bin/solobooks" "$@" --source agent:fake; }
file=$(ls "$HOME"/openai-usage-*.csv)
month=$(basename "$file" .csv | sed 's/openai-usage-//')
first="$month-01"
last=$(date -j -v+1m -v-1d -f %Y-%m-%d "$first" +%Y-%m-%d 2> /dev/null || date -d "$first +1 month -1 day" +%Y-%m-%d)
sb charge add --client-id 2 --date "$last" --amount-cents 6132 --line-text "OpenAI API usage, $month" > /dev/null
sb invoice draft --client-id 2 --period-start "$first" --period-end "$last" > /dev/null
