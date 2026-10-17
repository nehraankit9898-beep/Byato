#!/usr/bin/env node
/**
 * Smart Prisma client generation — fixes the "last generate wins" foot-gun.
 *
 * PROBLEM (reproduced 2026-10): both schemas (SQLite dev + PostgreSQL prod)
 * generate into the SAME output (node_modules/@prisma/client). The Netlify
 * `build` script generates the PostgreSQL client; any later `bun run test`
 * or `bun run dev` with a SQLite DATABASE_URL then fails with
 *   "Error validating datasource `db`: the URL must start with the protocol
 *    `postgresql://` or `postgres://`"
 * (PrismaClientInitializationError on the first query — HTTP 500 per route
 * in a server context).
 *
 * FIX: pick the schema from the DATABASE_URL protocol:
 *   postgres:// | postgresql:// → prisma/schema.postgres.prisma
 *   anything else (file:, unset) → prisma/schema.prisma (SQLite dev default)
 *
 * Wired into:
 *   - `postinstall` (fresh clones + CI + Netlify npm ci)
 *   - `dev`        (always regenerates before the dev server boots)
 *   - scripts/run-tests.ts (regenerates inside the test env)
 *
 * The Netlify `build` script stays explicit (schema.postgres.prisma) — it is
 * the authoritative production path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRISMA_BIN = join(ROOT, "node_modules", ".bin", "prisma");

const rawUrl = (process.env.DATABASE_URL || "").trim();
const isPostgres = /^postgres(ql)?:\/\//i.test(rawUrl);
// Test environment (STAYLOOP_TEST=1): use the pure-JS/WASM "client" engine
// schema so no native engine binary has to be downloaded (network-restricted
// CI sandboxes). The test schema is a copy of the SQLite dev schema whose
// generator block differs (engineType = "client"); a drift guard below makes
// sure the two never diverge on the actual data model.
const isTestEnv = process.env.STAYLOOP_TEST === "1";
const schema = isPostgres
  ? "prisma/schema.postgres.prisma"
  : isTestEnv
    ? "prisma/schema.test.prisma"
    : "prisma/schema.prisma";

if (!existsSync(join(ROOT, schema))) {
  console.error(`[prisma-generate] schema not found: ${schema}`);
  process.exit(1);
}

// Drift guard: the test schema must be a copy of the dev SQLite schema with
// ONLY the generator block (engineType) changed. A stale copy would silently
// make tests exercise an outdated data model.
if (isTestEnv && !isPostgres && existsSync(join(ROOT, "prisma/schema.prisma"))) {
  const stripGenerator = (text) =>
    text.replace(/generator\s+\w+\s*\{[\s\S]*?\n\}/, "").replace(/^\/\/.*$/gm, "").trim();
  const dev = stripGenerator(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8"));
  const test = stripGenerator(readFileSync(join(ROOT, schema), "utf8"));
  if (dev !== test) {
    console.error(
      "[prisma-generate] prisma/schema.test.prisma has drifted from prisma/schema.prisma " +
        "(they must stay identical apart from comments and the generator block).",
    );
    process.exit(1);
  }
}
if (!existsSync(PRISMA_BIN)) {
  // Dependencies not installed yet (e.g. postinstall of a partial install) —
  // not fatal; the dev/build/test entry points regenerate explicitly.
  console.warn(
    "[prisma-generate] prisma CLI not found (node_modules missing) — skipping generate.",
  );
  process.exit(0);
}

try {
  console.log(
    `[prisma-generate] DATABASE_URL ${isPostgres ? "is PostgreSQL" : "is SQLite/unset"} → generating client from ${schema}`,
  );
  execFileSync(PRISMA_BIN, ["generate", "--schema", schema], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (err) {
  console.error("[prisma-generate] failed:", err.message);
  process.exit(1);
}
