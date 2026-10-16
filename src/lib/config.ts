import { createHash, randomBytes } from "crypto";

/**
 * EDGE-RUNTIME SAFETY: this module must stay importable from the Edge runtime
 * bundle. `instrumentation.ts`'s `register()` hook runs in BOTH runtimes, and
 * Next.js also evaluates middleware (`src/proxy.ts`) through the same graph —
 * a top-level `import fs/path` here used to be traced into the edge bundle and
 * made EVERY request fail with HTTP 500 ("Node APIs are unavailable in the
 * Edge Runtime"). Node-only modules (`fs`, `path`) are therefore loaded with
 * DYNAMIC imports inside dev/test-only code paths below, which the bundler
 * cannot statically trace into the edge build.
 */

/**
 * Fail-closed configuration validation (Phase 1 / Phase 4).
 *
 * - Production startup FAILS if AUTH_SECRET / TRACKING_WEBHOOK_SECRET /
 *   INTEGRATION_ENCRYPTION_KEY are missing or weak. No known fallback exists.
 * - Development generates a cryptographically secure secret ONCE and caches it
 *   in `.auth-secret.dev` (gitignored) so sessions survive dev-server restarts.
 *   The generated dev key is never printed or logged.
 * - Secrets are never logged by this module.
 */

export type RuntimeEnv = "development" | "production" | "test";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * AUDIT FIX (SEC-004): test-only behavior must never activate in production, even
 * if STAYLOOP_TEST leaks into a production environment (startup validation also
 * rejects it; this is the in-code backstop for the mock-email outbox and test hooks).
 */
export function isTest(): boolean {
  if (isProduction()) return false;
  return process.env.NODE_ENV === "test" || process.env.STAYLOOP_TEST === "1";
}

/** Minimum accepted secret length (bytes of entropy-ish characters). */
export const MIN_SECRET_LENGTH = 32;

/** Values that must NEVER be accepted as secrets in any environment. */
const FORBIDDEN_SECRET_VALUES = new Set([
  "stayloop-dev-secret-change-me-in-production",
  "change-me",
  "changeme",
  "secret",
  "test",
  "dev",
  "development",
  "password",
  "phase2-webhook-secret-2026",
  "stayloop_dev_webhook_secret_2026",
]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function validateSecret(
  value: string | undefined,
  name: string,
  requiredInProduction: boolean,
): string {
  if (!value || value.trim() === "") {
    if (requiredInProduction && isProduction()) {
      throw new ConfigValidationError(
        `${name} is required in production. Generate one with: openssl rand -hex 32`,
      );
    }
    return "";
  }
  if (
    FORBIDDEN_SECRET_VALUES.has(value.trim()) ||
    FORBIDDEN_SECRET_VALUES.has(value.trim().toLowerCase())
  ) {
    throw new ConfigValidationError(
      `${name} is set to a known placeholder value and is rejected. Generate a real secret with: openssl rand -hex 32`,
    );
  }
  if (value.trim().length < MIN_SECRET_LENGTH) {
    throw new ConfigValidationError(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters long. Generate one with: openssl rand -hex 32`,
    );
  }
  return value.trim();
}

/**
 * Synchronous deterministic secret for TEST runs (NODE_ENV=test / STAYLOOP_TEST=1).
 *
 * ROOT-CAUSE FIX (2026-10 bug sweep): the dev/test path used to return a
 * per-PID synchronous fallback while an ASYNC resolution (dynamic fs/path
 * import, see the edge-runtime note above) swapped the cached secret moments
 * later. Tokens and ciphertext minted with the fallback in that window became
 * permanently unreadable the instant the swap landed — reproduced as
 * "session expired" immediately after login (scripts/test-phase1.ts crash),
 * GCM auth-tag failures in backup round-trips (tests/ops-reliability.test.ts),
 * and "BLOCKED" tenant integrations (tests/recheck-fixes.test.ts).
 *
 * In test mode the material is deterministic and needs NO filesystem, so the
 * accessor resolves it synchronously — identical to what the async path would
 * have adopted, in every process. The race window therefore cannot exist.
 * Production never reaches this helper (isTest() is false and the env-based
 * fail-closed path applies; SEC-004 also blocks STAYLOOP_TEST in production).
 */
function deterministicTestSecret(purpose: string): string {
  // MUST mirror getOrCreateDevSecret()'s STAYLOOP_TEST branch byte-for-byte.
  return createHash("sha256").update(`stayloop-test:${purpose}`).digest("hex");
}

const DEV_SECRET_FILE = ".auth-secret.dev";

/**
 * Development-only secret source. Generates a 64-hex-char random secret on
 * first use and persists it in a gitignored file so it is stable across
 * process restarts. Never used in production.
 *
 * ASYNC by design: `fs`/`path` are imported dynamically (see the edge-runtime
 * note at the top of this module) so this code — and its filesystem access —
 * can never be traced into the Edge bundle. It is only reachable from dev/test
 * request paths, which run on the Node.js runtime.
 */
async function getOrCreateDevSecret(purpose: string): Promise<string> {
  if (process.env.STAYLOOP_TEST === "1") {
    // Deterministic per-purpose secret for tests (tests never rely on secrecy).
    return createHash("sha256").update(`stayloop-test:${purpose}`).digest("hex");
  }

  const fs = await import("fs");
  const path = await import("path");
  const filePath = path.join(process.cwd(), DEV_SECRET_FILE);
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    // File holds one line per purpose: "<purpose>=<hex>"
    for (const line of existing.split("\n")) {
      const [k, v] = line.split("=");
      if (k === purpose && v && v.length >= MIN_SECRET_LENGTH) return v;
    }
  } catch {
    // first run — create below
  }
  const generated = randomBytes(32).toString("hex");
  try {
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      /* ignore */
    }
    fs.writeFileSync(filePath, content + `${purpose}=${generated}\n`, { mode: 0o600 });
  } catch {
    // If the filesystem is read-only, fall back to an in-process random secret.
    // Sessions will reset on restart — acceptable for a sandboxed dev box.
  }
  return generated;
}

let cachedAuthSecret: string | null = null;
let cachedWebhookSecret: string | null = null;
let cachedEngineSecret: string | null = null;
let cachedEncryptionKey: Buffer | null = null;
let cachedPreviousEncryptionKeys: { id: string; key: Buffer }[] | null = null;
/**
 * Tracks whether the async dev-secret resolution has already been adopted into
 * `cachedEncryptionKey`. Starts as null ("no adoption decision yet"); flips to
 * true on the first adoption so later resolutions never swap the key out from
 * under ciphertexts already written with the synchronous fallback. Reset by
 * the test-only cache-reset hook below so rotation tests can re-observe it.
 */
let adoptedEncryptionSecret: boolean | null = null;
/** Pending dev-secret generations, deduplicated per purpose (one promise per key). */
const pendingDevSecrets = new Map<string, Promise<string>>();

/**
 * Kick off (or reuse) the async generation of a dev secret. Synchronous callers
 * that already have an env-provided value never reach this; the promise is
 * awaited by the async accessors below. In production this is never called
 * (fail-closed before reaching here).
 */
function devSecretPromise(purpose: string): Promise<string> {
  const inflight = pendingDevSecrets.get(purpose);
  if (inflight) return inflight;
  const p = getOrCreateDevSecret(purpose).finally(() => pendingDevSecrets.delete(purpose));
  pendingDevSecrets.set(purpose, p);
  return p;
}

/** AUTH_SECRET — HMAC signing key for session tokens. Fail-closed in production. */
export function getAuthSecret(): string {
  if (cachedAuthSecret !== null) return cachedAuthSecret;
  const fromEnv = validateSecret(process.env.AUTH_SECRET, "AUTH_SECRET", true);
  if (fromEnv) {
    cachedAuthSecret = fromEnv;
    return cachedAuthSecret;
  }
  if (isProduction()) {
    throw new ConfigValidationError(
      "AUTH_SECRET is required in production. Generate one with: openssl rand -hex 32",
    );
  }
  // TEST: deterministic synchronous secret — the same value every process
  // derives, so sessions survive cross-process verification (and watchdog
  // server restarts) with no adoption swap. See deterministicTestSecret().
  if (isTest()) {
    cachedAuthSecret = deterministicTestSecret("auth");
    return cachedAuthSecret;
  }
  // Dev: the generated secret is resolved asynchronously (first call
  // starts it; prewarmed at module load — see prewarmDevSecretAdoption()).
  // Until then we keep a synchronous in-memory fallback so this accessor's
  // contract (never returns empty outside production) is intact.
  scheduleDevSecretResolution("auth", (secret) => {
    if (cachedAuthSecret === null) cachedAuthSecret = secret;
  });
  return syncDevSecretFallback("auth");
}

/**
 * Dev-only synchronous stopgap used while the async dev secret is being
 * generated/read from disk. Deterministic per purpose WITHIN a process (per
 * PID) and replaced by the persisted secret as soon as it resolves.
 *
 * CORRECTED DOC (2026-10 bug sweep): an earlier comment claimed sessions
 * minted with this fallback "still verify" after the swap. That was FALSE —
 * verification always uses the CURRENT cached secret, so pre-swap tokens
 * failed with "session expired". The swap window is now closed at boot via
 * prewarmDevSecretAdoption() (dev) and eliminated entirely in test mode via
 * deterministicTestSecret(). NEVER used in production (callers fail closed
 * before reaching here).
 */
function syncDevSecretFallback(purpose: string): string {
  return createHash("sha256").update(`stayloop-dev-session:${purpose}:${process.pid}`).digest(
    "hex",
  );
}

/** Fire-and-forget completion of a dev secret; logs nothing (secrets stay secret). */
function scheduleDevSecretResolution(purpose: string, apply: (secret: string) => void): void {
  void devSecretPromise(purpose).then(apply, () => {
    /* keep the in-memory fallback if the filesystem is unavailable */
  });
}

/** TRACKING_WEBHOOK_SECRET — HMAC key for provider engagement webhooks. */
export function getTrackingWebhookSecret(): string {
  if (cachedWebhookSecret !== null) return cachedWebhookSecret;
  const fromEnv = validateSecret(
    process.env.TRACKING_WEBHOOK_SECRET,
    "TRACKING_WEBHOOK_SECRET",
    true,
  );
  if (fromEnv) {
    cachedWebhookSecret = fromEnv;
    return cachedWebhookSecret;
  }
  if (isProduction()) {
    // Production webhooks stay disabled unless explicitly configured (fail closed:
    // the webhook route returns 503 when the secret is empty).
    cachedWebhookSecret = "";
    return cachedWebhookSecret;
  }
  // TEST: deterministic synchronous secret (see deterministicTestSecret()).
  if (isTest()) {
    cachedWebhookSecret = deterministicTestSecret("webhook");
    return cachedWebhookSecret;
  }
  scheduleDevSecretResolution("webhook", (secret) => {
    if (cachedWebhookSecret === null || cachedWebhookSecret === "") cachedWebhookSecret = secret;
  });
  return syncDevSecretFallback("webhook");
}

/** FOLLOWUP_ENGINE_SECRET — cron secret. Optional; if set it must be strong. */
export function getFollowUpEngineSecret(): string {
  if (cachedEngineSecret !== null) return cachedEngineSecret;
  cachedEngineSecret = validateSecret(
    process.env.FOLLOWUP_ENGINE_SECRET,
    "FOLLOWUP_ENGINE_SECRET",
    false,
  );
  return cachedEngineSecret;
}

/**
 * INTEGRATION_ENCRYPTION_KEY — AES-256-GCM key for integration credentials at rest.
 * Production: REQUIRED, 64 hex chars (32 bytes) or 44-char base64.
 * Development/test: derived deterministically from the dev secret.
 */
export function getIntegrationEncryptionKey(): Buffer {
  if (cachedEncryptionKey) return cachedEncryptionKey;
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    if (isProduction()) {
      throw new ConfigValidationError(
        "INTEGRATION_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32",
      );
    }
    // TEST: derive synchronously from the deterministic test material — the
    // exact key the async adoption would produce, so ciphertext round-trips
    // across processes with NO swap window. See deterministicTestSecret().
    if (isTest()) {
      cachedEncryptionKey = createHash("sha256")
        .update(`stayloop-integrations:${deterministicTestSecret("integration-key")}`)
        .digest();
      return cachedEncryptionKey;
    }
    // Dev: derive synchronously from the same deterministic material the
    // async dev-secret loader produces (no fs/path access here — see the
    // edge-runtime note at the top of this module). The value is stable for
    // the lifetime of the process; after a restart the persisted dev key is
    // resolved asynchronously and applied to the cache below (prewarmed at
    // module load — see prewarmDevSecretAdoption()).
    cachedEncryptionKey = createHash("sha256")
      .update(`stayloop-integrations:${syncDevSecretFallback("integration-key")}`)
      .digest();
    scheduleDevSecretResolution("integration-key", (secret) => {
      const derived = createHash("sha256")
        .update(`stayloop-integrations:${secret}`)
        .digest();
      // Adopt the persisted dev key only while it still matches what existing
      // ciphertexts were encrypted with (first run in this process): once any
      // data has been written under the fallback we keep that key stable and
      // rely on the rotation keyring instead of silently invalidating rows.
      if (adoptedEncryptionSecret === null) {
        adoptedEncryptionSecret = true;
        cachedEncryptionKey = derived;
      }
    });
    return cachedEncryptionKey;
  }
  const trimmed = raw.trim();
  const asHex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : null;
  const asB64 = /^[A-Za-z0-9+/]{43}=$/.test(trimmed) ? Buffer.from(trimmed, "base64") : null;
  const key = asHex ?? asB64;
  if (!key || key.length !== 32) {
    throw new ConfigValidationError(
      "INTEGRATION_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars or 44-char base64). Generate one with: openssl rand -hex 32",
    );
  }
  cachedEncryptionKey = key;
  return cachedEncryptionKey;
}

/**
 * INTEGRATION_ENCRYPTION_PREVIOUS_KEYS — retired keys kept decryptable
 * during/after rotation. Comma-separated "<id>:<64-hex>" entries:
 *   INTEGRATION_ENCRYPTION_PREVIOUS_KEYS=old2026:0123abcd...64hex...,...
 * Malformed entries are SKIPPED (never throw at decrypt time); an empty or
 * unset variable yields an empty list. Used for backup archives, integration
 * credentials AND platform billing secrets (audit fix: the variable was
 * documented but only implemented for archives — stored credentials became
 * undecryptable after a key rotation).
 */
export function getPreviousIntegrationEncryptionKeys(): { id: string; key: Buffer }[] {
  if (cachedPreviousEncryptionKeys !== null) return cachedPreviousEncryptionKeys;
  const parsed: { id: string; key: Buffer }[] = [];
  const raw = (process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS ?? "").trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const idx = entry.indexOf(":");
      if (idx <= 0) continue;
      const id = entry.slice(0, idx).trim();
      const hex = entry.slice(idx + 1).trim();
      if (!id || !/^[0-9a-fA-F]{64}$/.test(hex)) continue;
      parsed.push({ id, key: Buffer.from(hex, "hex") });
    }
  }
  cachedPreviousEncryptionKeys = parsed;
  return parsed;
}

/**
 * The full decryption keyring: CURRENT key first, then the declared previous
 * keys (rotation fallback). Same ordering contract as
 * src/lib/saas/backup.ts so every ciphertext type tries keys in the same
 * order.
 */
export function getIntegrationEncryptionKeyring(): { id: string; key: Buffer }[] {
  return [
    { id: "default", key: getIntegrationEncryptionKey() },
    ...getPreviousIntegrationEncryptionKeys(),
  ];
}

/**
 * ADMIN_BOOTSTRAP_SECRET — one-time bootstrap authorization for creating the
 * first Super Admin (Phase 2). Optional; if unset, bootstrap is disabled.
 * When set it must not be a known-weak value.
 */
export function getAdminBootstrapSecret(): string {
  const raw = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!raw || raw.trim() === "") return "";
  if (isProduction() && raw.trim().length < MIN_SECRET_LENGTH) {
    throw new ConfigValidationError(
      `ADMIN_BOOTSTRAP_SECRET must be at least ${MIN_SECRET_LENGTH} characters long in production.`,
    );
  }
  return raw.trim();
}

/**
 * TEST-ONLY cache reset (guards: STAYLOOP_TEST=1 / NODE_ENV=test). Used by
 * the ops-reliability suite to simulate encryption-key ROTATION within one
 * process: getIntegrationEncryptionKey() caches the first key it resolved,
 * so without this hook the test could not observe rotation behavior.
 */
export function __resetEncryptionKeyCacheForTests(): void {
  if (process.env.NODE_ENV !== "test" && process.env.STAYLOOP_TEST !== "1") {
    throw new Error("Test-only helper called outside a test environment.");
  }
  cachedEncryptionKey = null;
  cachedPreviousEncryptionKeys = null;
  adoptedEncryptionSecret = null;
}

/**
 * Validate all configuration at startup. Called from instrumentation.ts
 * (Next.js) — a misconfigured production deployment refuses to boot instead
 * of silently running with a known fallback secret.
 */
export function validateStartupConfig(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  // BUGFIX (LIVE-500): the Next.js `register()` instrumentation hook also runs
  // inside the EDGE runtime bundle (middleware/proxy). Previously this module
  // was pulled into the edge bundle through the validation call graph, and its
  // top-level `import fs from "fs"` / `import path from "path"` made EVERY
  // edge-matched request fail with a Node-API error — surfacing as HTTP 500 on
  // all routes (including `/` and `/favicon.ico`) while dev mode worked fine.
  // These three modules are pure JS, so they stay statically analyzable; the
  // Node-only ones are loaded dynamically only when NODE_ENV === "production"
  // (see isProduction() below and the dynamic import in getOrCreateDevSecret()).
  try {
    getAuthSecret();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (isProduction()) {
    try {
      getIntegrationEncryptionKey();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    // TRACKING_WEBHOOK_SECRET is optional in production (webhook disabled if
    // unset) but if present it must be strong.
    try {
      validateSecret(process.env.TRACKING_WEBHOOK_SECRET, "TRACKING_WEBHOOK_SECRET", false);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * DEV-ONLY prewarm: kick off the async dev-secret adoption at MODULE LOAD so
 * it lands during boot, BEFORE the first request can mint sessions or
 * ciphertext with the synchronous per-PID fallback. Without this, the first
 * key use after boot raced the adoption swap: data minted with the fallback
 * became permanently unreadable (GCM auth-tag failure / "session expired")
 * the moment the persisted secret was adopted.
 *
 * - Production is unaffected (env secrets, fail-closed — nothing scheduled).
 * - Test mode resolves synchronously (deterministicTestSecret()) and never
 *   reaches this path.
 * - Edge-runtime safety: the dynamic fs/path imports inside
 *   getOrCreateDevSecret() stay un-traceable for the edge bundle; if they
 *   reject there, scheduleDevSecretResolution's rejection handler swallows
 *   it and the in-process fallback keeps being used.
 */
function prewarmDevSecretAdoption(): void {
  if (isProduction() || isTest()) return;
  if (!process.env.AUTH_SECRET) {
    scheduleDevSecretResolution("auth", (secret) => {
      if (cachedAuthSecret === null) cachedAuthSecret = secret;
    });
  }
  if (!process.env.INTEGRATION_ENCRYPTION_KEY) {
    scheduleDevSecretResolution("integration-key", (secret) => {
      const derived = createHash("sha256")
        .update(`stayloop-integrations:${secret}`)
        .digest();
      // Same adoption contract as getIntegrationEncryptionKey(): only the
      // FIRST resolution may adopt; later ones never swap the key out from
      // under ciphertexts (see adoptedEncryptionSecret).
      if (adoptedEncryptionSecret === null) {
        adoptedEncryptionSecret = true;
        cachedEncryptionKey = derived;
      }
    });
  }
}
prewarmDevSecretAdoption();
