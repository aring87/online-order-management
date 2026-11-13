#!/bin/bash
# Double-click to start the orders program on a Mac.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed on this computer."
  echo "  Download the \"LTS\" version from https://nodejs.org, install it, then double-click this file again."
  open https://nodejs.org
  read -r -p "Press Enter to close."
  exit 1
fi

[ -d node_modules ] || { echo "  First-time setup, please wait..."; npm install --omit=dev --no-audit --no-fund; }
[ -f .env ] || cp .env.example .env

OPEN_BROWSER=1 node --no-warnings --env-file-if-exists=.env src/server.js
