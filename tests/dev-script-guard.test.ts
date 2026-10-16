/**
 * Dev-only scripts (seed / reset / known-password helpers) must refuse to run
 * against a PostgreSQL (production/Neon) DATABASE_URL. Runs the guard in a
 * child process so process.exit() can be observed.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

function runGuard(env: Record<string, string | undefined>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  delete base.NODE_ENV;
  delete base.DATABASE_URL;
  delete base.STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES;
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) base[k] = v;
  }
  return spawnSync(
    process.execPath,
    [
      "-e",
      `import { assertDevOnlyScript } from "./scripts/dev-only-guard"; assertDevOnlyScript("test");`,
    ],
    { cwd: ROOT, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 },
  );
}

describe("assertDevOnlyScript", () => {
  test("SQLite DATABASE_URL (local development) is allowed", () => {
    const res = runGuard({ DATABASE_URL: "file:../db/custom.db" });
    expect(res.status).toBe(0);
  });

  test("unset DATABASE_URL is allowed (local development)", () => {
    expect(runGuard({}).status).toBe(0);
  });

  test("PostgreSQL DATABASE_URL is refused, and the URL is not printed", () => {
    const url = "postgresql://stayloop:s3cret-pass@ep-prod.neon.tech/stayloop?sslmode=require";
    const res = runGuard({ DATABASE_URL: url });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("refused");
    expect(res.stderr + res.stdout).not.toContain("s3cret-pass");
    expect(res.stderr + res.stdout).not.toContain(url);
  });

  test("explicit opt-in allows a deliberate local PostgreSQL dev database", () => {
    const res = runGuard({
      DATABASE_URL: "postgresql://stayloop:devpass@localhost:5432/stayloop_dev",
      STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES: "1",
    });
    expect(res.status).toBe(0);
  });

  test("NODE_ENV=production is always refused, even with the opt-in", () => {
    const res = runGuard({
      NODE_ENV: "production",
      DATABASE_URL: "file:../db/custom.db",
      STAYLOOP_ALLOW_DEV_SCRIPT_ON_POSTGRES: "1",
    });
    expect(res.status).toBe(1);
  });
});
