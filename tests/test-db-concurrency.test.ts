/**
 * Regression suite — SQLite lock contention in the test harness.
 *
 * Pins the two mechanisms that keep the per-file test processes (and the
 * long-lived dev server) from aborting each other's fixtures with
 * `SQLITE_BUSY: database is locked` / `Operation has timed out`:
 *
 *   1. `enableSqliteWal()` switches the disposable test database to WAL, so a
 *      reader is never blocked by an open write transaction.
 *   2. `retryOnSqliteContention()` retries ONLY transient lock errors — never
 *      validation/constraint/authorization failures.
 *
 * Why this exists: CI runs 39564794979 and 39565955894 failed with
 * `PrismaClientKnownRequestError: Operation has timed out` inside
 * `tests/super-admin-platform.test.ts:103` and `tests/audit-fixes.test.ts:746`.
 * In the first case the throw happened before the suite's `saJar` was
 * assigned, so every later request answered 401 (a misleading auth cascade).
 * Removing WAL, or making the retry swallow other errors, makes this suite
 * fail.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  enableSqliteWal,
  isSqliteContentionError,
  retryOnSqliteContention,
} from "../scripts/test-db-concurrency";

const dir = mkdtempSync(join(tmpdir(), "stayloop-db-concurrency-"));
const dbUrl = `file:${join(dir, "concurrency.db")}`;

const clients: ReturnType<typeof createClient>[] = [];
function openClient() {
  const client = createClient({ url: dbUrl });
  clients.push(client);
  return client;
}

afterAll(() => {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("test-database concurrency (WAL + contention retries)", () => {
  test("enableSqliteWal switches the file to WAL and the mode persists", async () => {
    const setup = openClient();
    await setup.execute("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, v TEXT)");

    const mode = await enableSqliteWal(dbUrl);
    expect(mode).toBe("wal");

    // A brand-new connection (i.e. another test process / the dev server)
    // must observe WAL — it is stored in the database file, not the client.
    const fresh = openClient();
    const journal = await fresh.execute("PRAGMA journal_mode");
    expect(String(journal.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
  });

  test("a reader is NOT blocked while another connection holds a write lock", async () => {
    const writer = openClient();
    const reader = openClient();

    await writer.execute("BEGIN IMMEDIATE");
    await writer.execute("INSERT INTO probe (v) VALUES ('held')");

    // The exact CI failure shape: a fixture read while the server writes.
    // With WAL this returns immediately; with the old rollback journal it
    // raised SQLITE_BUSY after ~0 ms.
    const started = Date.now();
    try {
      const result = await reader.execute("SELECT COUNT(*) AS n FROM probe");
      expect(Number(result.rows[0]?.n)).toBeGreaterThanOrEqual(0);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await writer.execute("ROLLBACK");
    }
  });

  test("retryOnSqliteContention rides out a transient writer lock", async () => {
    const holder = openClient();
    const writer = openClient();

    await holder.execute("BEGIN IMMEDIATE");
    await holder.execute("INSERT INTO probe (v) VALUES ('holder')");

    let attempts = 0;
    const write = retryOnSqliteContention(
      async () => {
        attempts += 1;
        return writer.execute("INSERT INTO probe (v) VALUES ('retried')");
      },
      { attempts: 10, baseDelayMs: 40, maxDelayMs: 400 },
    );

    // Release the lock while the retry loop is backing off. Awaited so the
    // COMMIT is finished before the next test opens the database.
    const release = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await holder.execute("COMMIT");
    })();

    await expect(write).resolves.toBeTruthy();
    await release;
    holder.close();
    writer.close();
    // Proves the retry actually engaged (a single attempt would have thrown).
    expect(attempts).toBeGreaterThan(1);
  });

  test("non-contention errors are NEVER retried (no masking of real defects)", async () => {
    // Own database file: this test asserts on error CLASSIFICATION, so it must
    // not depend on lock state left behind by the previous scenarios.
    const client = createClient({ url: `file:${join(dir, "uniq.db")}` });
    clients.push(client);
    await client.execute("CREATE TABLE IF NOT EXISTS uniq (id INTEGER PRIMARY KEY, v TEXT)");
    await client.execute("INSERT INTO uniq (id, v) VALUES (1, 'first')");

    let attempts = 0;
    let caught: unknown;
    try {
      await retryOnSqliteContention(
        async () => {
          attempts += 1;
          return client.execute("INSERT INTO uniq (id, v) VALUES (1, 'duplicate')");
        },
        { attempts: 5, baseDelayMs: 10, maxDelayMs: 20 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeTruthy();
    expect(attempts).toBe(1);
    expect(isSqliteContentionError(caught)).toBe(false);
    expect(String((caught as { message?: string }).message)).toMatch(/UNIQUE|constraint/i);
  });

  test("contention classification matches the signatures seen in CI", () => {
    expect(isSqliteContentionError({ code: "P2010", message: "Raw query failed" })).toBe(true);
    expect(isSqliteContentionError({ code: "P1008", message: "" })).toBe(true);
    expect(isSqliteContentionError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isSqliteContentionError(new Error("Operation has timed out"))).toBe(true);
    // Unrelated failures must not be classified as contention.
    expect(isSqliteContentionError({ code: "P2002", message: "Unique constraint failed" })).toBe(
      false,
    );
    expect(isSqliteContentionError(new Error("Unauthorized"))).toBe(false);
    expect(isSqliteContentionError(null)).toBe(false);
  });
});
