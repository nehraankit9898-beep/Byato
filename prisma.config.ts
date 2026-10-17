/**
 * Prisma CLI configuration.
 *
 * By default this file is a no-op: it only pins the schema path and keeps
 * every command's behavior exactly as before (classic schema engine).
 *
 * EXCEPTION — test environment (STAYLOOP_TEST=1):
 *
 * `prisma db push` (and friends) normally launch the native schema-engine
 * binary. In network-restricted CI sandboxes (e.g. this Arena workspace) that
 * binary cannot be downloaded from binaries.prisma.sh, so the test harness
 * switches the CLI to the JS/WASM schema engine shipped inside the `prisma`
 * npm package itself, plus the pure-JS LibSQL driver adapter for SQLite.
 *
 * This ONLY affects CLI migration commands in the disposable test database
 * (a fresh temp-dir SQLite file created by scripts/run-tests.ts). It does
 * not change:
 *   - `prisma generate` (the client is still generated from the schema's
 *     own `engineType`),
 *   - any production/development command (STAYLOOP_TEST is never set there),
 *   - the deployed application (which talks to PostgreSQL via the standard
 *     Prisma client, see src/lib/db.ts).
 */
import { defineConfig } from "prisma/config";
import { PrismaLibSQL } from "@prisma/adapter-libsql";

const isTestEnv = process.env.STAYLOOP_TEST === "1";
const rawUrl = (process.env.DATABASE_URL || "file:./dev.db").trim();

// NOTE: the CLI accepts the adapter INSTANCE here (verified: `prisma db push`
// logs "using driver adapter @prisma/adapter-libsql" and succeeds). The
// declared config type wants a factory whose exact interface is NOT exported
// from @prisma/config, so we satisfy the generic bound explicitly.
const testAdapter = (async () => new PrismaLibSQL({ url: rawUrl })) as unknown as () => Promise<never>;

export default isTestEnv && rawUrl.startsWith("file:")
  ? defineConfig({
      schema: "prisma/schema.prisma",
      // JS (WASM) engine + driver adapter: no native binary required.
      experimental: { adapter: true },
      engine: "js",
      adapter: testAdapter,
    })
  : defineConfig({
      schema: "prisma/schema.prisma",
    });
