/**
 * SQLite concurrency helpers for the DISPOSABLE test database.
 *
 * ROOT CAUSE this module fixes (reproduced 2026-10-21, CI runs
 * 39564794979 and 39565955894):
 *
 *   The test harness creates a fresh SQLite file, pushes the schema with
 *   `prisma db push`, and then runs each suite in its OWN process while a
 *   long-lived `next dev` server keeps its own connection to the same file.
 *   Two processes therefore write to one database concurrently.
 *
 *   SQLite was left in its default rollback-journal mode with
 *   `busy_timeout = 0`, so a second writer (and even a reader) failed
 *   IMMEDIATELY with `SQLITE_BUSY: database is locked`. Observed effects:
 *
 *     1. `tests/super-admin-platform.test.ts:103` — a fixture
 *        `db.user.updateMany(...)` threw
 *        `PrismaClientKnownRequestError: Operation has timed out` before the
 *        module-level `saJar` was assigned, so EVERY later request in the
 *        file answered 401 (a misleading "auth" cascade).
 *     2. `tests/audit-fixes.test.ts:746` — `db.customer.findFirst(...)`
 *        timed out while the server held a write lock.
 *
 *   Two mitigations, both test-only:
 *
 *     a) WAL journal mode (persistent in the database file): readers no
 *        longer block behind a writer. Verified: with a write transaction
 *        open, a concurrent `SELECT` returns in ~0 ms instead of raising
 *        SQLITE_BUSY.
 *     b) Bounded retries for the residual writer-vs-writer collisions.
 *        `PRAGMA busy_timeout` is NOT honoured through the libsql native
 *        binding (verified: a write with `busy_timeout = 30000` still raised
 *        SQLITE_BUSY in 0 ms), so the retry has to happen in JavaScript.
 *
 * Neither helper is imported by application code: production runs on
 * PostgreSQL and never touches this file.
 */
import { createClient } from "@libsql/client";

export const WAL_JOURNAL_MODE = "wal";

/**
 * Put a file-backed SQLite database into WAL mode and verify the switch.
 *
 * WAL is a persistent property of the database file, so setting it once (in
 * the harness, before the server starts) covers every process that opens the
 * database afterwards.
 */
export async function enableSqliteWal(url: string): Promise<string> {
  if (!url.startsWith("file:")) {
    throw new Error(
      `enableSqliteWal() only accepts file: SQLite URLs (got "${url.split(":")[0]}:")`,
    );
  }
  const client = createClient({ url });
  try {
    const result = await client.execute("PRAGMA journal_mode = WAL");
    const mode = String(result.rows[0]?.journal_mode ?? "").toLowerCase();
    if (mode !== WAL_JOURNAL_MODE) {
      throw new Error(
        `Could not switch the test database to WAL (journal_mode="${mode}"). ` +
          "Concurrent test processes would hit SQLITE_BUSY again.",
      );
    }
    return mode;
  } finally {
    client.close();
  }
}

/**
 * Prisma error codes that, in this SQLite test harness, mean "another process
 * holds the write lock" rather than "the query is wrong":
 *   P1008 — operation timed out (observed on contended fixture writes)
 *   P2010 — raw query failed (SQLITE_BUSY surfaces here)
 *   P2024 — timed out fetching a connection
 *   P2028 — transaction API error (lock acquisition failed)
 */
const CONTENTION_CODES = new Set(["P1008", "P2010", "P2024", "P2028"]);

const CONTENTION_MESSAGE =
  /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked|Operation has timed out/i;

/** True when the error is a transient SQLite lock/contention failure. */
export function isSqliteContentionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONTENTION_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && CONTENTION_MESSAGE.test(message);
}

export interface SqliteRetryOptions {
  /** Total attempts, including the first one. Default 8 (~3.5 s of backoff). */
  attempts?: number;
  /** First backoff delay in ms (doubles per attempt). Default 50. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 1000. */
  maxDelayMs?: number;
}

/**
 * Run `operation`, retrying ONLY transient SQLite contention errors.
 *
 * Any other error (validation, unique constraint, authorization, …) is
 * re-thrown on the first attempt, so this can never mask a genuine defect.
 * A retried SQLITE_BUSY never committed, so repeating the statement cannot
 * duplicate a write.
 */
export async function retryOnSqliteContention<T>(
  operation: () => Promise<T>,
  options: SqliteRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 50);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 1000);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteContentionError(error) || attempt === attempts - 1) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError;
}
