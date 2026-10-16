/**
 * Super Admin bootstrap — endpoint contract + configuration rules (DB-free).
 *
 * These tests exercise every bootstrap branch that is decided BEFORE the
 * database is needed: fail-closed configuration, secret validation, header
 * handling, rate limiting and body validation. The already-bootstrapped (409)
 * and happy-path (201) branches need PostgreSQL/SQLite and are covered by
 * tests/bootstrap-atomicity.test.ts and tests/super-admin-platform.test.ts.
 *
 * Run standalone: bun test tests/bootstrap-endpoint.test.ts
 */
// MUST be the first import: points DATABASE_URL at a throwaway, empty SQLite
// file so any audit write from the 401 path fails harmlessly instead of
// touching a developer's real database.
import "./queue-test-env";
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { cleanupQueueTestTmp } from "./queue-test-env";
import { ConfigValidationError, getAdminBootstrapSecret } from "../src/lib/config";
import { __resetInMemoryBuckets } from "../src/lib/rate-limit";
import { validateExtendedEnv } from "../src/lib/env";

/**
 * In-memory stand-in for the Prisma client used by the bootstrap code path.
 * The claim row uses the same compare-and-swap semantics as the real
 * `updateMany({ where: { key, value: "false" } })`, so the concurrency test
 * below exercises the real claim logic in src/lib/super-admin.ts.
 * `failNextCount` lets a test simulate a database outage.
 */
const fakeDb = {
  superAdminCount: 0,
  existingEmails: new Set<string>(),
  settings: new Map<string, string>(),
  created: [] as Array<{ email: string; passwordHash: string; role: string }>,
  failNextCount: null as Error | null,
  reset() {
    this.superAdminCount = 0;
    this.existingEmails = new Set();
    this.settings = new Map();
    this.created = [];
    this.failNextCount = null;
  },
};

mock.module("../src/lib/db", () => ({
  db: {
    user: {
      count: async () => {
        if (fakeDb.failNextCount) {
          const err = fakeDb.failNextCount;
          fakeDb.failNextCount = null;
          throw err;
        }
        return fakeDb.superAdminCount;
      },
      findUnique: async ({ where }: { where: { email: string } }) =>
        fakeDb.existingEmails.has(where.email) ? { id: "existing", email: where.email } : null,
      create: async ({ data }: { data: { email: string; passwordHash: string; role: string } }) => {
        fakeDb.created.push(data);
        fakeDb.superAdminCount += data.role === "SUPER_ADMIN" ? 1 : 0;
        fakeDb.existingEmails.add(data.email);
        return { id: `user-${fakeDb.created.length}`, email: data.email };
      },
    },
    platformSetting: {
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        if (!fakeDb.settings.has(where.key)) fakeDb.settings.set(where.key, create.value);
        return {};
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; value?: string };
        data: { value: string };
      }) => {
        const current = fakeDb.settings.get(where.key);
        if (where.value !== undefined && current !== where.value) return { count: 0 };
        if (current === undefined) return { count: 0 };
        fakeDb.settings.set(where.key, data.value);
        return { count: 1 };
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

const STRONG_SECRET = "bootstrap-test-secret-0123456789abcdef0123456789abcdef";
const ORIGINAL_ENV = { ...process.env };

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let ipCounter = 0;
function bootstrapRequest(opts: {
  secret?: string | null;
  body?: unknown;
  rawBody?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Unique IP per request so the in-memory rate limiter never interferes.
    "x-forwarded-for": `203.0.113.${(ipCounter++ % 250) + 1}`,
  };
  if (opts.secret !== null && opts.secret !== undefined) {
    headers["x-bootstrap-secret"] = opts.secret;
  }
  const body =
    opts.rawBody ?? JSON.stringify(opts.body ?? { name: "Platform Admin", email: "a@b.co" });
  return new Request("http://localhost/api/super-admin/bootstrap", {
    method: "POST",
    headers,
    body,
  });
}

async function callBootstrap(req: Request) {
  const { POST } = await import("../src/app/api/super-admin/bootstrap/route");
  const res = await POST(req);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

beforeEach(() => {
  __resetInMemoryBuckets();
  fakeDb.reset();
  setEnv({ ADMIN_BOOTSTRAP_SECRET: STRONG_SECRET, NODE_ENV: "test", REDIS_URL: undefined });
});

afterEach(() => {
  // Restore key-by-key: replacing process.env wholesale is not supported.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
});

afterAll(() => {
  cleanupQueueTestTmp();
});

describe("getAdminBootstrapSecret — configuration rules", () => {
  test("unset or blank → '' (bootstrap disabled, fail closed)", () => {
    setEnv({ ADMIN_BOOTSTRAP_SECRET: undefined });
    expect(getAdminBootstrapSecret()).toBe("");
    setEnv({ ADMIN_BOOTSTRAP_SECRET: "   " });
    expect(getAdminBootstrapSecret()).toBe("");
  });

  test("a strong secret is returned trimmed", () => {
    setEnv({ ADMIN_BOOTSTRAP_SECRET: `  ${STRONG_SECRET}\n` });
    expect(getAdminBootstrapSecret()).toBe(STRONG_SECRET);
  });

  test("too-short secret is rejected in every environment (not only production)", () => {
    for (const env of ["test", "development", "production"]) {
      setEnv({ NODE_ENV: env, ADMIN_BOOTSTRAP_SECRET: "short-secret-value" });
      expect(() => getAdminBootstrapSecret()).toThrow(ConfigValidationError);
    }
  });

  test("placeholder values are rejected and the error never echoes the value", () => {
    setEnv({ ADMIN_BOOTSTRAP_SECRET: "change-me" });
    let message = "";
    try {
      getAdminBootstrapSecret();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ADMIN_BOOTSTRAP_SECRET");
    expect(message).not.toContain("change-me");
  });
});

describe("POST /api/super-admin/bootstrap — fail-closed configuration", () => {
  test("no ADMIN_BOOTSTRAP_SECRET → 403 BOOTSTRAP_DISABLED, even with a guessed header", async () => {
    setEnv({ ADMIN_BOOTSTRAP_SECRET: undefined });
    const res = await callBootstrap(bootstrapRequest({ secret: STRONG_SECRET }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("BOOTSTRAP_DISABLED");
  });

  test("weak configured secret → 500 BOOTSTRAP_MISCONFIGURED, not 400 and not 401", async () => {
    setEnv({ ADMIN_BOOTSTRAP_SECRET: "too-short" });
    const res = await callBootstrap(bootstrapRequest({ secret: "too-short" }));
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe("BOOTSTRAP_MISCONFIGURED");
    expect(res.text).not.toContain("too-short");
  });
});

describe("POST /api/super-admin/bootstrap — secret handling", () => {
  test("missing x-bootstrap-secret header → 401 with a header-specific hint", async () => {
    const res = await callBootstrap(bootstrapRequest({ secret: null }));
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("UNAUTHORIZED");
    expect(res.json.error.message).toContain("x-bootstrap-secret");
  });

  test("wrong secret → 401 and the response never contains either secret", async () => {
    const wrong = "wrong-bootstrap-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await callBootstrap(bootstrapRequest({ secret: wrong }));
    expect(res.status).toBe(401);
    expect(res.json.error.message).toBe("Invalid bootstrap secret.");
    expect(res.text).not.toContain(wrong);
    expect(res.text).not.toContain(STRONG_SECRET);
  });

  test("a secret that is a prefix of the real one → 401 (no prefix acceptance)", async () => {
    const res = await callBootstrap(
      bootstrapRequest({ secret: STRONG_SECRET.slice(0, STRONG_SECRET.length - 1) }),
    );
    expect(res.status).toBe(401);
  });

  test("the secret sent in the JSON body (not the header) is NOT accepted → 401", async () => {
    const res = await callBootstrap(
      bootstrapRequest({
        secret: null,
        body: { name: "Platform Admin", email: "a@b.co", secret: STRONG_SECRET },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("surrounding whitespace in the header is tolerated (matches trimmed config)", async () => {
    // Authenticates (no 401), then fails body validation → 400, which needs no DB.
    const res = await callBootstrap(
      bootstrapRequest({ secret: `  ${STRONG_SECRET}  `, body: { name: "" } }),
    );
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("BAD_REQUEST");
  });
});

describe("POST /api/super-admin/bootstrap — request validation", () => {
  test("non-JSON body → 400 BAD_REQUEST (after successful authentication)", async () => {
    const res = await callBootstrap(
      bootstrapRequest({ secret: STRONG_SECRET, rawBody: "not json" }),
    );
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("BAD_REQUEST");
  });

  test("invalid email → 400 and no internal details", async () => {
    const res = await callBootstrap(
      bootstrapRequest({ secret: STRONG_SECRET, body: { name: "Admin", email: "not-an-email" } }),
    );
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/prisma|stack|at /i);
  });
});

describe("POST /api/super-admin/bootstrap — rate limiting", () => {
  test("more than 5 attempts per minute from one IP → 429", async () => {
    const fixedIp = "198.51.100.77";
    const make = () =>
      new Request("http://localhost/api/super-admin/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": fixedIp,
          "x-bootstrap-secret": "wrong-bootstrap-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        body: "{}",
      });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await callBootstrap(make())).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(statuses[6]).toBe(429);
  });
});

describe("validateExtendedEnv — production DATABASE_URL", () => {
  function prodErrors(databaseUrl: string | undefined): string[] {
    setEnv({
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      // Satisfy the unrelated production checks so only DATABASE_URL is judged.
      AUTH_SECRET: STRONG_SECRET,
      INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
      APP_ORIGIN: "https://app.example.com",
      EMAIL_PROVIDER: undefined,
    });
    return validateExtendedEnv().errors;
  }

  test("missing DATABASE_URL in production is a startup error", () => {
    expect(prodErrors(undefined).join("\n")).toContain("DATABASE_URL is required in production");
  });

  test("SQLite file: URL in production is rejected", () => {
    expect(prodErrors("file:../db/custom.db").join("\n")).toContain("PostgreSQL connection string");
  });

  test("non-PostgreSQL scheme in production is rejected", () => {
    expect(prodErrors("mysql://u:p@host/db").join("\n")).toContain("must start with postgresql://");
  });

  test("a Neon-style postgresql:// URL passes the DATABASE_URL checks", () => {
    const errors = prodErrors(
      "postgresql://user:pass@ep-example-pooler.us-east-2.aws.neon.tech/stayloop?sslmode=require&pgbouncer=true",
    );
    expect(errors.join("\n")).not.toContain("DATABASE_URL");
  });

  test("development never requires DATABASE_URL", () => {
    setEnv({ NODE_ENV: "development", DATABASE_URL: undefined });
    expect(validateExtendedEnv().errors.join("\n")).not.toContain("DATABASE_URL");
  });
});

describe("POST /api/super-admin/bootstrap — database-backed branches (mocked db)", () => {
  test("already bootstrapped → 409 ALREADY_BOOTSTRAPPED and no account is created", async () => {
    fakeDb.superAdminCount = 1;
    const res = await callBootstrap(bootstrapRequest({ secret: STRONG_SECRET }));
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("ALREADY_BOOTSTRAPPED");
    expect(fakeDb.created.length).toBe(0);
  });

  test("email already in use → 409 EMAIL_IN_USE", async () => {
    fakeDb.existingEmails.add("taken@example.com");
    const res = await callBootstrap(
      bootstrapRequest({
        secret: STRONG_SECRET,
        body: { name: "Platform Admin", email: "taken@example.com" },
      }),
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("EMAIL_IN_USE");
    expect(fakeDb.created.length).toBe(0);
  });

  test("success → 201 with a one-time temporary password; stored only as a scrypt hash", async () => {
    const logged: string[] = [];
    const spies = [
      { target: console, key: "log" as const },
      { target: console, key: "error" as const },
      { target: console, key: "warn" as const },
    ].map(({ target, key }) => {
      const original = target[key];
      target[key] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      return { target, key, original };
    });
    let res: Awaited<ReturnType<typeof callBootstrap>>;
    try {
      res = await callBootstrap(
        bootstrapRequest({
          secret: STRONG_SECRET,
          body: { name: "Platform Admin", email: "Founder@Example.com" },
        }),
      );
    } finally {
      for (const s of spies) s.target[s.key] = s.original;
    }

    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    expect(res.json.mustChangePassword).toBe(true);
    expect(res.json.admin.email).toBe("founder@example.com");
    const tempPassword: string = res.json.temporaryPassword;
    expect(tempPassword.length).toBeGreaterThanOrEqual(24);

    // Stored as a password hash, never as plaintext.
    const stored = fakeDb.created[0];
    expect(stored.role).toBe("SUPER_ADMIN");
    expect(stored.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(stored.passwordHash).not.toContain(tempPassword);

    // Never logged.
    expect(logged.join("\n")).not.toContain(tempPassword);
    expect(logged.join("\n")).not.toContain(STRONG_SECRET);
  });

  test("a database outage → 500 INTERNAL with no connection details leaked", async () => {
    fakeDb.failNextCount = new Error(
      "connect ECONNREFUSED postgresql://stayloop:hunter2@db.neon.tech/prod",
    );
    const quiet = console.error;
    console.error = () => {};
    let res: Awaited<ReturnType<typeof callBootstrap>>;
    try {
      res = await callBootstrap(bootstrapRequest({ secret: STRONG_SECRET }));
    } finally {
      console.error = quiet;
    }
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe("INTERNAL");
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("postgresql://");
    expect(res.text).not.toContain("ECONNREFUSED");
  });
});

describe("bootstrapFirstSuperAdmin — atomic claim (mocked db)", () => {
  test("two CONCURRENT bootstraps create exactly one Super Admin", async () => {
    const { bootstrapFirstSuperAdmin, BootstrapConflictError: Conflict } =
      await import("../src/lib/super-admin");
    const results = await Promise.allSettled([
      bootstrapFirstSuperAdmin({
        name: "A",
        email: "a@example.com",
        bootstrapSecret: STRONG_SECRET,
      }),
      bootstrapFirstSuperAdmin({
        name: "B",
        email: "b@example.com",
        bootstrapSecret: STRONG_SECRET,
      }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].reason).toBeInstanceOf(Conflict);
    expect(fakeDb.created.length).toBe(1);
  });

  test("an empty authorization secret is never accepted by the service itself", async () => {
    const { bootstrapFirstSuperAdmin } = await import("../src/lib/super-admin");
    await expect(
      bootstrapFirstSuperAdmin({ name: "A", email: "a@example.com", bootstrapSecret: "  " }),
    ).rejects.toThrow(/authorization secret/);
    expect(fakeDb.created.length).toBe(0);
  });

  test("a rejected BootstrapConflictError carries the machine-readable code", async () => {
    fakeDb.superAdminCount = 1;
    const { bootstrapFirstSuperAdmin, BootstrapConflictError: Conflict } =
      await import("../src/lib/super-admin");
    const err = await bootstrapFirstSuperAdmin({
      name: "A",
      email: "a@example.com",
      bootstrapSecret: STRONG_SECRET,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Conflict);
    expect(err.code).toBe("ALREADY_BOOTSTRAPPED");
    expect(err.message).toMatch(/already exists/);
  });
});
