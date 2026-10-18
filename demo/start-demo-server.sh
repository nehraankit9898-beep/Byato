#!/usr/bin/env bash
# Starts the Byato demo server (local dev mode, synthetic data only).
#
#   ./demo/start-demo-server.sh [port]
#
# Uses .env.demo (git ignored) for DATABASE_URL / AUTH_SECRET so the running
# app matches the seeded demo database and the enrolled demo MFA factor.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${1:-3000}"

if [ ! -f "$ROOT/.env.demo" ]; then
  echo "Missing .env.demo — run ./demo/setup-demo.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a
. "$ROOT/.env.demo"
set +a

export PRISMA_QUERY_ENGINE_LIBRARY="${TMPDIR:-/tmp}/byato-demo/prisma-engine-stub.so.node"
export NODE_ENV=development

echo "→ Byato demo server on http://localhost:${PORT} (fictional demo data)"
exec npx next dev -p "$PORT" -H 0.0.0.0
