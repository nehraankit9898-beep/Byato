/**
 * Prisma client factory for standalone scripts (seeds, dev tools).
 *
 * In the security-test environment (STAYLOOP_TEST=1, SQLite) the client is
 * generated with the pure-JS/WASM "client" query engine, which requires a
 * driver adapter — the same rule src/lib/db.ts applies to the app singleton.
 * Outside the test environment this is a plain `new PrismaClient()`
 * (classic engine), exactly as the scripts behaved before.
 */
import { PrismaClient } from "@prisma/client";

export function createScriptPrismaClient(): PrismaClient {
  const url = (process.env.DATABASE_URL || "").trim();
  if (process.env.STAYLOOP_TEST === "1" && url.startsWith("file:")) {
    // Test-only synchronous adapter loading keeps this path out of production initialization.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaLibSQL } = require("@prisma/adapter-libsql") as typeof import("@prisma/adapter-libsql");
    return new PrismaClient({
      adapter: new PrismaLibSQL({ url: url.split("?")[0] }),
    });
  }
  return new PrismaClient();
}
