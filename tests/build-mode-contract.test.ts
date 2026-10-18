import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("default build and start use the standard Next output", () => {
  expect(pkg.scripts.build).toContain("next build");
  expect(pkg.scripts.start).toBe("next start -H 0.0.0.0");
});

test("standalone build generates the production client and has an explicit start command", () => {
  expect(pkg.scripts["build:standalone"]).toContain(
    "prisma generate --schema prisma/schema.postgres.prisma",
  );
  expect(pkg.scripts["build:standalone"]).toContain("STAYLOOP_STANDALONE=1 next build");
  expect(pkg.scripts["start:standalone"]).toContain(".next/standalone/server.js");
});

test("PostgreSQL integration CI builds the standalone artifact its runner requires", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("  postgres-integration:")[1].split("  docker:")[0];
  expect(job).toContain("run: bun run build:standalone");
});

test("BUG-18 frozen Bun workspace declarations match package.json", () => {
  // Bun's text lockfile is JSON with trailing commas, not executable JS.
  const lock = JSON.parse(
    readFileSync(resolve(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"),
  );
  for (const section of ["dependencies", "devDependencies"] as const) {
    expect(lock.workspaces[""][section]).toEqual(pkg[section]);
  }
});
