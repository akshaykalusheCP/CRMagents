#!/bin/sh
# A fresh one-time Salesforce session link (from the CLI's login) for a path in the agentforce demo org, written to a file.
sf org open -o akshaykalushe765@agentforce.com --url-only --path "$1" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['url'])" > "$2"
