#!/usr/bin/env sh
# Run the app locally on stubs — no Google credentials required.
# Usage: npm run dev     (or: PORT=9000 npm run dev)
set -eu

cd "$(dirname "$0")/.."

export DB_PATH="${DB_PATH:-./data/pegasus.db}"
export LOCAL_UPLOAD_DIR="${LOCAL_UPLOAD_DIR:-./data/uploads}"
export TEAM_PASSCODE="${TEAM_PASSCODE:-pegasus-dev}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-dev}"
export SESSION_SECRET="${SESSION_SECRET:-dev-insecure-secret-change-me}"
# This script deliberately serves with well-known dev secrets, so it must opt in
# to the startup guard bypass. Nothing outside this script sets this flag, which
# is why `npm start` on a bare checkout still refuses to start. It also keeps
# the session cookie non-Secure so plain-http localhost works.
export ALLOW_INSECURE_DEFAULTS="${ALLOW_INSECURE_DEFAULTS:-1}"
# 8000 is taken by Apache on the dev Mac.
export PORT="${PORT:-8811}"
# Loopback only: the dev secrets above are public, so never expose this on the LAN.
export HOST="${HOST:-127.0.0.1}"

echo "DB_PATH=$DB_PATH"
echo "ALLOW_INSECURE_DEFAULTS=$ALLOW_INSECURE_DEFAULTS  (local dev only)"
echo "team passcode: $TEAM_PASSCODE   admin password: $ADMIN_PASSWORD"
echo "open http://127.0.0.1:$PORT/"

exec node --watch src/server.js
