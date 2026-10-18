#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Byato demo environment — local, isolated, synthetic data only.
#
# Creates a THROWAWAY SQLite database (db/demo.db) and seeds it with the
# standard demo data plus the fictional Byato demo dataset. Never touches
# PostgreSQL / production: the dev-only guard in every seed script refuses a
# postgres:// DATABASE_URL, and this script only ever writes db/demo.db.
#
#   ./demo/setup-demo.sh          # create + seed + print demo accounts
#
# The generated .env.demo holds a throwaway AUTH_SECRET for the local dev
# server only (git ignored). It is NOT a production secret.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUN="${BUN_BIN:-$(command -v bun || echo "$ROOT/node_modules/.bin/bun")}"
DB_FILE="$ROOT/db/demo.db"
DB_URL="file:$DB_FILE"
STUB_DIR="${TMPDIR:-/tmp}/byato-demo"
ENGINE_STUB="$STUB_DIR/prisma-engine-stub.so.node"

mkdir -p "$ROOT/db" "$STUB_DIR"

# A stable local-only auth secret. The dev server and the seed scripts must
# share it (the MFA key is derived from it).
if [ -f "$ROOT/.env.demo" ]; then
  # shellcheck disable=SC1091
  set -a
  . "$ROOT/.env.demo"
  set +a
else
  AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$ROOT/.env.demo" <<EOF
# Local demo environment for the Byato product video (git ignored).
# Throwaway values — development only, never used in production.
AUTH_SECRET=$AUTH_SECRET
DATABASE_URL=$DB_URL
STAYLOOP_TEST=1
EOF
  chmod 600 "$ROOT/.env.demo"
  echo "→ wrote .env.demo (local dev only)"
fi
# shellcheck disable=SC1091
set -a
. "$ROOT/.env.demo"
set +a

# The Prisma CLI only needs the query-engine file to EXIST in this sandbox
# (the client itself runs on the pure-JS/WASM engine + a driver adapter).
printf 'stub: prisma CLI preflight existence check only; never loaded\n' > "$ENGINE_STUB"
export PRISMA_QUERY_ENGINE_LIBRARY="$ENGINE_STUB"
export STAYLOOP_TEST=1
export DATABASE_URL="$DB_URL"

echo "→ generating prisma client (WASM engine + libsql adapter)"
STAYLOOP_TEST=1 node scripts/prisma-generate.mjs >/dev/null

echo "→ creating database schema"
npx prisma db push --skip-generate --accept-data-loss >/dev/null

echo "→ seeding base demo data"
STAYLOOP_SEED_ADMIN_PASSWORD="DemoAdmin@2026" \
STAYLOOP_SEED_STAFF_PASSWORD="DemoStaff@2026" \
  "$BUN" run scripts/seed.ts | tail -3
"$BUN" run scripts/seed-phase3-6.ts | tail -2
"$BUN" run scripts/seed-phase63.ts | tail -2

echo "→ seeding Byato demo dataset (fictional tenants + demo accounts)"
DEMO_SUPER_ADMIN_PASSWORD="DemoSuper@2026" \
DEMO_HOTEL_ADMIN_PASSWORD="DemoHotelAdmin@2026" \
DEMO_STAFF_PASSWORD="DemoStaff@2026" \
DEMO_OTHER_ADMIN_PASSWORD="DemoOtherAdmin@2026" \
DEMO_MANAGER_PASSWORD="DemoManager@2026" \
DEMO_WAITER_PASSWORD="DemoWaiter@2026" \
DEMO_KITCHEN_PASSWORD="DemoKitchen@2026" \
  "$BUN" run scripts/seed-demo-video.ts | tail -14

echo
echo "Done. Start the demo server with:  ./demo/start-demo-server.sh"
