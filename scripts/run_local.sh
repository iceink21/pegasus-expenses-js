#!/usr/bin/env sh
# Run the app locally on stubs — no Google credentials required.
# Usage: npm run dev     (or: PORT=9000 npm run dev)
# Optional keys (e.g. OPENROUTER_API_KEY) are read from ./.env if it exists.
# Shell variables win over .env, so `OPENROUTER_API_KEY= npm run dev` turns the
# LLM stage off for one run.
set -eu

cd "$(dirname "$0")/.."

export DB_PATH="${DB_PATH:-./data/pegasus.db}"
export LOCAL_UPLOAD_DIR="${LOCAL_UPLOAD_DIR:-./data/uploads}"
# Used once, to create the first admin account (username "admin") when the
# database has none; it must be changed at first login and is ignored after.
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-dev-password}"
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
echo "first start on an empty database: log in as admin / $ADMIN_PASSWORD (then set your own password)"
echo "locked out? npm run admin:reset -- <username>"
echo "open http://127.0.0.1:$PORT/"

exec node --env-file-if-exists=.env --watch src/server.js
