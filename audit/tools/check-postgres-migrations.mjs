#!/usr/bin/env node
/** Disposable PostgreSQL/WASM migration smoke test. Never reads DATABASE_URL.
 * Install tools OUTSIDE the app: npm install --prefix /tmp/stayloop-audit-tools
 *   --no-audit --no-fund @electric-sql/pglite@0.5.10
 * Run: node audit/tools/check-postgres-migrations.mjs /tmp/stayloop-audit-tools
 * This does not replace the PostgreSQL 16 / Neon migration + drift CI job.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (!process.argv[2]) throw new Error("Pass an external directory containing @electric-sql/pglite@0.5.10");
const requireTool = createRequire(resolve(process.argv[2], "package.json"));
const { PGlite } = requireTool("@electric-sql/pglite");
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations");
const sql = (name) => readFileSync(resolve(migrations, name, "migration.sql"), "utf8");
const pg = new PGlite(); // in-memory only: cannot connect to production
try {
  console.log((await pg.query("SELECT version() AS version")).rows[0].version);
  for (const migration of readdirSync(migrations).filter((name) => /^\d/.test(name)).sort()) {
    if (migration === "0012_reservation_active_fence") {
      // Existing tenant data before the new nullable fence is introduced.
      await pg.exec(`INSERT INTO "Hotel" (id,name,"updatedAt") VALUES ('audit-hotel','Audit',NOW());
        INSERT INTO "Reservation" (id,"hotelId",date,"startTime","partySize",status,"guestName","guestPhone","updatedAt")
        VALUES ('active','audit-hotel','2026-10-18','12:00',2,'CONFIRMED','Test','not-real',NOW()),
               ('cancelled','audit-hotel','2026-10-18','13:00',2,'CANCELLED','Test','not-real',NOW());`);
    }
    await pg.exec(sql(migration));
    console.log(`PASS ${migration}`);
  }
  const tables = (await pg.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n;
  assert.equal(Number(tables), 110);
  assert.deepEqual((await pg.query('SELECT id,"activeFence" FROM "Reservation" ORDER BY id')).rows, [
    { id: "active", activeFence: 1 }, { id: "cancelled", activeFence: null },
  ]);
  console.log("PASS existing reservation fence backfill; 110 tables");
  for (const migration of ["0012_reservation_active_fence", "0013_bill_payment_idempotency", "0014_schema_drift_parity_fix"]) {
    await pg.exec(sql(migration));
    console.log(`PASS reapply ${migration}`);
  }
  await pg.exec(`INSERT INTO "Customer" (id,"hotelId",name,phone,"updatedAt")
    VALUES ('c1','audit-hotel','Guest 1','test-phone-1',NOW()), ('c2','audit-hotel','Guest 2','test-phone-2',NOW());`);
  await assert.rejects(pg.exec(`UPDATE "Customer" SET phone='[DELETED]' WHERE "hotelId"='audit-hotel';`), /duplicate key/);
  await pg.query('UPDATE "Customer" SET phone=$1 || id WHERE "hotelId"=$2', ["[DELETED]:test-namespace:", "audit-hotel"]);
  assert.equal(Number((await pg.query('SELECT count(DISTINCT phone) AS n FROM "Customer"')).rows[0].n), 2);
  console.log("PASS BUG-16 original uniqueness failure and parameterized tombstone update on PostgreSQL");
} finally {
  await pg.close();
}
