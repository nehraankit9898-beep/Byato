/**
 * Deployment configuration invariants — regression tests for the three
 * production deployment bugs fixed in this release (plus the compose
 * interpolation blocker):
 *
 *  A1. Dockerfile deps stage MUST copy prisma/ into ./prisma/ (the generate
 *      step expects /app/prisma/schema.postgres.prisma; `COPY prisma ./`
 *      flattened the directory and broke the ENTIRE docker build at stage 1).
 *  A2. Every `docker build` that tags the WEB image MUST pass --target web
 *      (the LAST Dockerfile stage is admin-bootstrap, so a target-less build
 *      produces the ADMIN image — CI scanned/deployed the wrong image).
 *  A3. The admin-bootstrap stage MUST define an ENTRYPOINT (the documented
 *      `compose run --rm admin --name X --email y` appends its arguments to
 *      ENTRYPOINT; with only a CMD the arguments REPLACE the command).
 *  A4. docker-compose.prod.yml MUST NOT use `${ADMIN_BOOTSTRAP_SECRET:?…}`
 *      required interpolation on the inactive-profile `admin` service —
 *      compose interpolates the whole file before profile filtering, so the
 *      documented "remove the secret after bootstrap" step broke every
 *      subsequent compose command (verified: `docker compose config` exits
 *      15 without the variable).
 *  A5. Every GitHub Actions `uses:` ref MUST resolve to a tag that actually
 *      exists upstream — `aquasecurity/trivy-action@0.36.0` (no `v`) made the
 *      whole docker job fail at "Set up job", silently skipping the Docker +
 *      Trivy + compose + backup/restore gate while the other jobs stayed green.
 *  A6. A failing `docker build` MUST be diagnosable from run metadata: one named
 *      step per target, plain progress, log captured, tail echoed to the step
 *      log + an ::error annotation + the job summary, errexit disabled so the
 *      diagnostics run at all, and the step still exits non-zero.
 *  A7. The Docker `deps` layer MUST survive package.json's root postinstall —
 *      it copies only the two manifests, so `node scripts/prisma-generate.mjs`
 *      died with MODULE_NOT_FOUND and every image build failed in stage 1.
 *
 * These are static invariants (no Docker daemon required). When a compose
 * binary IS available (env DOCKER_COMPOSE_BIN, or `docker compose` on PATH),
 * the real `config` interpolation check runs as well.
 */
import { describe, test, expect } from "bun:test";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const dockerfile = read("Dockerfile");
const ci = read(".github/workflows/ci.yml");
const compose = read("docker-compose.prod.yml");
const deploymentDoc = read("DEPLOYMENT.md");

/** All build stage names in Dockerfile order. */
const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((m) => m[1]);

describe("A1 — Dockerfile deps stage copies prisma/ correctly", () => {
  test("deps stage uses `COPY prisma ./prisma/` (directory layout preserved)", () => {
    const depsSection = dockerfile.split(/AS deps\b/)[1]?.split(/^FROM /m)[0] ?? "";
    expect(depsSection).toContain("COPY prisma ./prisma/");
  });

  test("no flattening `COPY prisma ./` remains anywhere in the Dockerfile", () => {
    // Exact-line match: `COPY prisma ./` copies CONTENTS into /app and breaks
    // `prisma generate --schema prisma/schema.postgres.prisma`.
    expect(/^COPY prisma \.\/\s*$/m.test(dockerfile)).toBe(false);
  });

  test("the generate step that expects ./prisma/schema.postgres.prisma still exists", () => {
    const depsSection = dockerfile.split(/AS deps\b/)[1]?.split(/^FROM /m)[0] ?? "";
    expect(depsSection).toContain("--schema prisma/schema.postgres.prisma");
  });
});

describe("A2 — web image builds always pass --target web", () => {
  test("the LAST Dockerfile stage is admin-bootstrap (why --target is mandatory)", () => {
    expect(stages.length).toBeGreaterThan(0);
    expect(stages[stages.length - 1]).toBe("admin-bootstrap");
  });

  test("a `web` stage exists to target", () => {
    expect(stages).toContain("web");
  });

  test("CI builds the web image with --target web", () => {
    const buildLines = ci.split(/\r?\n/).filter((l) => /^\s*docker build\b/.test(l));
    expect(buildLines.length).toBeGreaterThanOrEqual(2);
    for (const line of buildLines) {
      if (/stayloop-web/.test(line)) {
        expect(line).toContain("--target web");
      }
      if (/stayloop-worker/.test(line)) {
        expect(line).toContain("--target worker");
      }
    }
  });

  test("documentation never shows a target-less build for the web image", () => {
    // README + DEPLOYMENT must not teach the broken command.
    for (const doc of [read("README.md"), deploymentDoc]) {
      const bad = doc
        .split(/\r?\n/)
        .filter((l) => /docker build\s+-t\s+stayloop-web/.test(l) && !/--target\s+web/.test(l));
      expect(bad).toEqual([]);
    }
  });
});

describe("A3 — admin-bootstrap is ENTRYPOINT-based (compose run args append)", () => {
  test("the admin-bootstrap stage defines the bootstrap ENTRYPOINT", () => {
    const adminSection = dockerfile.split(/AS admin-bootstrap\b/)[1] ?? "";
    expect(adminSection).toContain('ENTRYPOINT ["bun", "scripts/bootstrap-admin.ts"]');
  });

  test("the documented compose bootstrap command appends --name/--email", () => {
    // The command shape operators copy-paste from DEPLOYMENT.md §6 and the
    // compose header. With ENTRYPOINT semantics these become script args.
    expect(deploymentDoc).toContain("--profile admin run --rm admin");
    const cmd = deploymentDoc.split(/\r?\n/).filter((l) => l.includes("run --rm admin"));
    expect(cmd.length).toBeGreaterThanOrEqual(1);
    expect(deploymentDoc).toMatch(/--name\s+"Platform Admin"/);
    expect(deploymentDoc).toMatch(/--email\s+you@example\.com/);
  });
});

describe("A4 — ADMIN_BOOTSTRAP_SECRET does not block the stack (inactive profile)", () => {
  // Effective (non-comment) YAML lines only — explanatory comments may quote
  // the broken syntax they document.
  const composeEffective = compose
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("compose uses optional interpolation for ADMIN_BOOTSTRAP_SECRET", () => {
    // Required interpolation `:?` on ANY service makes compose fail at model
    // load time — even for services excluded by profiles.
    expect(composeEffective).not.toContain("${ADMIN_BOOTSTRAP_SECRET:?");
    expect(composeEffective).toContain("${ADMIN_BOOTSTRAP_SECRET:-}");
  });

  test("required interpolations remain only for always-on services", () => {
    // DATABASE_URL / DATABASE_PASSWORD / DOMAIN / ACME_EMAIL belong to
    // postgres/web/caddy — services that are ALWAYS active — where failing
    // without them is correct fail-closed behavior.
    for (const m of composeEffective.matchAll(/\$\{(\w+):\?[^}]*\}/g)) {
      expect(["DATABASE_URL", "DATABASE_PASSWORD", "DOMAIN", "ACME_EMAIL"]).toContain(m[1]);
    }
  });

  test("the admin service stays behind the admin profile", () => {
    const adminBlock = compose.split(/^  admin:/m)[1]?.split(/^  \w/m)[0] ?? "";
    expect(adminBlock).toContain('profiles: ["admin"]');
    expect(adminBlock).toContain("target: admin-bootstrap");
  });

  test("the web service builds the web target", () => {
    const webBlock = compose.split(/^  web:/m)[1]?.split(/^  \w/m)[0] ?? "";
    expect(webBlock).toContain("target: web");
  });

  // REAL interpolation check — runs when a compose binary is available
  // (local sandbox: DOCKER_COMPOSE_BIN=/path/to/compose; GitHub CI: docker).
  test("docker compose config succeeds WITHOUT ADMIN_BOOTSTRAP_SECRET (when binary available)", () => {
    const candidates: { cmd: string; args: string[] }[] = [];
    if (process.env.DOCKER_COMPOSE_BIN) {
      candidates.push({
        cmd: process.env.DOCKER_COMPOSE_BIN,
        args: ["-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
    } else {
      candidates.push({
        cmd: "docker",
        args: ["compose", "-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
      candidates.push({
        cmd: "docker-compose",
        args: ["-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
    }

    let ran = false;
    let lastCode: number | null = null;
    for (const candidate of candidates) {
      const tmp = mkdtempSync(join(tmpdir(), "stayloop-compose-check-"));
      try {
        mkdirSync(join(tmp, "prisma"), { recursive: true });
        writeFileSync(join(tmp, "docker-compose.prod.yml"), compose);
        // .env WITHOUT ADMIN_BOOTSTRAP_SECRET — the documented post-bootstrap
        // state. Required vars for always-on services are provided.
        writeFileSync(
          join(tmp, ".env"),
          [
            "DATABASE_PASSWORD=testpassword0123456789abcdef",
            "DATABASE_URL=postgresql://stayloop:testpassword0123456789abcdef@postgres:5432/stayloop?schema=public",
            "DOMAIN=app.example.com",
            "ACME_EMAIL=ops@example.com",
            "",
          ].join("\n"),
        );
        const res = spawnSync(candidate.cmd, candidate.args, {
          cwd: tmp,
          encoding: "utf8",
          timeout: 60_000,
        });
        if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") continue; // not installed
        ran = true;
        lastCode = res.status;
        if (res.status !== 0) {
          console.error(
            "compose config failed:\n" + ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 1000),
          );
        }
        break;
      } finally {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }

    if (!ran) {
      console.log(
        "SKIP — no docker/compose binary available in this environment (static invariants above still apply)",
      );
      return;
    }
    expect(lastCode).toBe(0);
  });
});

describe("dockerignore / build context sanity", () => {
  test("prisma/ is NOT excluded from the build context", () => {
    const dockerignore = read(".dockerignore");
    const lines = dockerignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.find((l) => l === "prisma" || l === "prisma/" || l === "/prisma")).toBeUndefined();
  });

  test("the prisma directory actually contains the Postgres schema", () => {
    expect(existsSync(join(ROOT, "prisma", "schema.postgres.prisma"))).toBe(true);
  });
});

/**
 * A5 — GitHub Actions `uses:` refs must resolve to real published versions.
 *
 * CI-001 (found 2026-10-19 on `main`, runs 39142757093 → 39238304015): the
 * docker job pinned `aquasecurity/trivy-action@0.36.0`, but that repository
 * publishes its tags WITH a `v` prefix. GitHub cannot resolve a non-existent
 * ref, so the job failed at "Set up job" in ~3 s — before ANY step ran. The
 * other three jobs stayed green, so the run looked like "one flaky job" while
 * in fact the ENTIRE docker gate (web/worker image build, Trivy HIGH/CRITICAL
 * scan, compose startup + health checks, in-stack export round-trip, pg_dump
 * backup + restore) had never executed. LAUNCH_CHECKLIST §A still lists that
 * job as a release gate, so an unresolvable ref silently removes a gate.
 *
 * The allowlist below was verified against the GitHub API on 2026-10-19
 * (`/repos/{owner}/{repo}/git/ref/tags/{tag}` → 200 for each; the same call
 * returns 404 for `aquasecurity/trivy-action/0.36.0`). Bumping a version is a
 * deliberate act: change the workflow AND this list, and re-verify the tag.
 */
const VERIFIED_ACTION_REFS: ReadonlySet<string> = new Set([
  "actions/checkout@v4", // tags v4 … v4.4.0 exist (Node 20 runtime, deprecation warning only)
  "oven-sh/setup-bun@v2", // tag v2 exists (v2.2.0 is the current patch)
  "aquasecurity/trivy-action@v0.36.0", // upstream tags are v-prefixed; `0.36.0` does NOT exist
]);

/** Every `uses:` reference in every workflow file, with its source file. */
function workflowActionRefs(): { file: string; ref: string }[] {
  const dir = join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const refs: { file: string; ref: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    for (const m of text.matchAll(/^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)) {
      refs.push({ file: `.github/workflows/${entry}`, ref: m[1] });
    }
  }
  return refs;
}

describe("A5 — GitHub Actions refs resolve to real published versions (CI-001)", () => {
  const refs = workflowActionRefs();

  test("the CI workflow exists and declares action refs", () => {
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some((r) => r.file.endsWith("ci.yml"))).toBe(true);
  });

  test("every `uses:` ref is on the verified allowlist or a commit SHA", () => {
    // A 40-hex commit SHA is always accepted (immutable pin). Anything else
    // must have been checked by hand against the upstream tag list.
    const unknown = refs.filter(
      (r) => !VERIFIED_ACTION_REFS.has(r.ref) && !/^[^@]+@[0-9a-f]{40}$/.test(r.ref),
    );
    expect(unknown).toEqual([]);
  });

  test("no action is pinned to a bare numeric tag (the CI-001 typo class)", () => {
    // `owner/repo@0.36.0` — every action used here publishes `v`-prefixed tags,
    // so a ref starting with a digit cannot resolve and kills the whole job.
    const bareNumeric = refs.filter((r) => /@\d/.test(r.ref));
    expect(bareNumeric).toEqual([]);
  });

  test("the Trivy scans still gate on HIGH/CRITICAL with a failing exit code", () => {
    // Guard against "fixing" CI-001 by weakening the scan instead.
    const trivySteps = ci.split(/^\s*- name: Trivy vulnerability scan/m).slice(1);
    expect(trivySteps.length).toBe(2);
    for (const step of trivySteps) {
      expect(step).toContain("aquasecurity/trivy-action@v");
      expect(step).toContain("severity: HIGH,CRITICAL");
      expect(step).toContain('exit-code: "1"');
    }
  });
});

/**
 * A6 — a failing `docker build` must be diagnosable from the run metadata.
 *
 * CI-002 (2026-10-19): once CI-001 was fixed and the docker job actually ran,
 * it failed in the single "Build production images" step, which built BOTH
 * targets. The run metadata said only "Process completed with exit code 1":
 * the step list could not say which target broke, and the raw log archive is
 * served from `results-receiver.actions.githubusercontent.com` — a different
 * host than the API — so a restricted environment (or anyone without the log
 * download) could not see the cause at all.
 *
 * The steps below keep the gate exactly as strict (each build still exits
 * non-zero) while making the failure legible: one named step per target,
 * `--progress=plain`, the log captured to a file, its tail echoed to the step
 * log AND published as an `::error` check annotation (readable through
 * `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`).
 */
describe("A6 — docker build failures are diagnosable (CI-002)", () => {
  const dockerJob = ci.split(/^  docker:/m)[1]?.split(/^ {2}\w[\w-]*:/m)[0] ?? "";

  test("the docker job exists in the workflow", () => {
    expect(dockerJob.length).toBeGreaterThan(0);
  });

  test("each image target is built in its own named step", () => {
    expect(dockerJob).toContain("name: Build web image (--target web)");
    expect(dockerJob).toContain("name: Build worker image (--target worker)");
  });

  test("builds use plain progress and capture the full log to a file", () => {
    const builds = dockerJob.split(/\r?\n/).filter((l) => /^\s*docker build\b/.test(l));
    expect(builds.length).toBe(2);
    for (const line of builds) {
      expect(line).toContain("--progress=plain");
      expect(line).toMatch(/> \/tmp\/build-(web|worker)\.log 2>&1/);
    }
  });

  test("a failed build prints its log tail AND raises a check annotation", () => {
    // Annotations are the only failure text reachable through the API host.
    expect((dockerJob.match(/::error title=docker build/g) ?? []).length).toBe(2);
    expect(
      (dockerJob.match(/tail -n \d+ \/tmp\/build-(?:web|worker)\.log/g) ?? []).length,
    ).toBeGreaterThanOrEqual(4);
  });

  test("the build steps still fail the job (gate not weakened)", () => {
    expect((dockerJob.match(/exit "\$status"/g) ?? []).length).toBe(2);
    expect(dockerJob).not.toMatch(/docker build[^\n]*\|\|\s*true/);
  });

  test("build steps disable errexit so the diagnostics actually run", () => {
    // GitHub executes `run:` blocks with `bash -e {0}`. Without an explicit
    // `set +e` the step dies ON the failing `docker build` line, before the
    // tail/annotation/summary code runs — which is why the first CI-002 attempt
    // still surfaced only "Process completed with exit code 1".
    const blocks = dockerJob.split(/- name: Build (?:web|worker) image/).slice(1);
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      const plusE = block.indexOf("set +e");
      const build = block.search(/^\s*docker build\b/m);
      const capture = block.indexOf("status=$?");
      expect(plusE).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(-1);
      expect(capture).toBeGreaterThan(-1);
      expect(plusE).toBeLessThan(build);
      expect(build).toBeLessThan(capture);
    }
  });

  test("the failure text also lands in the job summary", () => {
    // Second outlet for environments that cannot reach the log-archive host.
    expect((dockerJob.match(/>> "\$GITHUB_STEP_SUMMARY"/g) ?? []).length).toBe(2);
  });
});

/**
 * A7 — the Docker `deps` layer must survive package.json's root postinstall.
 *
 * CI-003 (2026-10-19): once CI-001/CI-002 let the docker job run, `docker build
 * --target web` died in stage 1. The deps layer copies only `package.json` and
 * `bun.lock` (that is what makes the layer cacheable), then runs
 * `bun install --frozen-lockfile` — and bun runs the ROOT package's
 * `postinstall`, which is `node scripts/prisma-generate.mjs`. That file is not
 * in the layer, so the install aborted:
 *
 *   error: postinstall script from "stayloop" exited with 1
 *   Error: Cannot find module '/app/scripts/prisma-generate.mjs'
 *
 * Reproduced outside Docker (see the last test below) and now fixed by copying
 * that one script into the layer and letting it stand down for the install
 * command only — the PostgreSQL client is generated explicitly right after, so
 * nothing is lost, and dependency lifecycle scripts still run.
 */
describe("A7 — Docker deps layer survives the root postinstall (CI-003)", () => {
  const depsStage = dockerfile.split(/AS deps\b/)[1]?.split(/^FROM /m)[0] ?? "";
  // Effective (non-comment) lines only — the explanatory comments quote the
  // broken commands they document, so raw indexOf() would match prose.
  const effective = depsStage.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const lineIndex = (pred: (line: string) => boolean) => effective.findIndex(pred);

  test("the deps stage exists and installs with a frozen lockfile", () => {
    expect(depsStage.length).toBeGreaterThan(0);
    expect(effective.some((l) => /bun install --frozen-lockfile/.test(l))).toBe(true);
  });

  test("the postinstall script is copied BEFORE the install runs", () => {
    const copyAt = lineIndex((l) => l.includes("COPY scripts/prisma-generate.mjs ./scripts/"));
    const installAt = lineIndex((l) => /bun install --frozen-lockfile/.test(l));
    expect(copyAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(copyAt).toBeLessThan(installAt);
  });

  test("the install opts the postinstall out INLINE (never via ENV)", () => {
    expect(
      effective.some((l) =>
        /RUN STAYLOOP_SKIP_PRISMA_GENERATE=1 bun install --frozen-lockfile/.test(l),
      ),
    ).toBe(true);
    // An ENV would leak into the explicit generate below and into later stages,
    // silently shipping an image with no Prisma client.
    expect(/^ENV\s+STAYLOOP_SKIP_PRISMA_GENERATE/m.test(dockerfile)).toBe(false);
    expect((dockerfile.match(/STAYLOOP_SKIP_PRISMA_GENERATE=1/g) ?? []).length).toBe(1);
  });

  test("the explicit PostgreSQL generate still happens after the schemas land", () => {
    const schemasAt = lineIndex((l) => l.includes("COPY prisma ./prisma/"));
    const generateAt = lineIndex((l) => l.includes("--schema prisma/schema.postgres.prisma"));
    expect(schemasAt).toBeGreaterThan(-1);
    expect(generateAt).toBeGreaterThan(schemasAt);
  });

  /** Run the REAL script in a directory shaped like the deps layer. */
  function runScriptInDepsLayer(opts: { withScript: boolean; skip: boolean }) {
    const tmp = mkdtempSync(join(tmpdir(), "stayloop-deps-layer-"));
    try {
      if (opts.withScript) {
        mkdirSync(join(tmp, "scripts"), { recursive: true });
        writeFileSync(
          join(tmp, "scripts", "prisma-generate.mjs"),
          read("scripts/prisma-generate.mjs"),
        );
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (opts.skip) env.STAYLOOP_SKIP_PRISMA_GENERATE = "1";
      else delete env.STAYLOOP_SKIP_PRISMA_GENERATE;
      return spawnSync(process.execPath, [join("scripts", "prisma-generate.mjs")], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 30_000,
        env,
      });
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  test("with the script present + the flag set, the postinstall exits 0 (the fixed layer)", () => {
    const res = runScriptInDepsLayer({ withScript: true, skip: true });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("skipping");
  });

  test("without the flag the same layer still fails loudly (the opt-out is not a blanket skip)", () => {
    // No prisma/ directory in the deps layer → the script must refuse, not
    // silently pretend it generated a client.
    const res = runScriptInDepsLayer({ withScript: true, skip: false });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain("schema not found");
  });

  test("the original defect is real: no script in the layer → module-not-found, exit != 0", () => {
    const res = runScriptInDepsLayer({ withScript: false, skip: true });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(
      /Cannot find module|Module not found|MODULE_NOT_FOUND/i,
    );
  });
});
