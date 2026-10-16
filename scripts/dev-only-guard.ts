/**
 * Safety guard for development-only scripts (seed / reset / known-password
 * helpers). These scripts delete data or create accounts with predictable
 * passwords, so they must never run against the production PostgreSQL (Neon)
 * database by accident — e.g. `bun run seed` with a Neon DATABASE_URL in .env.
 *
 * Rules:
 *   - NODE_ENV=production            → always refused.
 *   - DATABASE_URL is PostgreSQL     → refused unless the operator explicitly
 *                                       sets STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES=1
 *                                       (a deliberate local Postgres dev database).
 *   - SQLite / unset (local dev)     → allowed.
 *
 * The check prints only the script name and the rule; it never prints the URL.
 */
export function assertDevOnlyScript(scriptName: string): void {
  if (process.env.NODE_ENV === "production") {
    console.error(
      `[${scriptName}] refused: NODE_ENV=production. This is a development-only script.`,
    );
    process.exit(1);
  }
  const url = (process.env.DATABASE_URL ?? "").trim();
  const isPostgres = /^postgres(ql)?:\/\//i.test(url);
  if (isPostgres && process.env.STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES !== "1") {
    console.error(
      `[${scriptName}] refused: DATABASE_URL points to PostgreSQL (possibly production/Neon). ` +
        "This script deletes data or creates known-password accounts. " +
        "Use a local SQLite DATABASE_URL, or set STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES=1 " +
        "only for a throwaway local Postgres database.",
    );
    process.exit(1);
  }
}
