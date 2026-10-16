/**
 * Regression suite — async dev/test secret-adoption race (2026-10 bug sweep).
 *
 * ROOT CAUSE being pinned: getAuthSecret()/getIntegrationEncryptionKey() used
 * to return a per-PID synchronous fallback on first use while an ASYNC
 * resolution swapped the cached secret moments later. Effects (all observed
 * in the 2026-10-16 run):
 *   - scripts/test-phase1.ts crashed: login succeeded, the next request got
 *     401 "Your session has expired" (token minted with the pre-swap secret).
 *   - tests/ops-reliability.test.ts: encrypt→verify/decrypt round trips
 *     failed GCM authentication ("Unsupported state or unable to
 *     authenticate data").
 *   - tests/recheck-fixes.test.ts: freshly stored integration credentials
 *     became unreadable → resolveTenantProvider() reported "BLOCKED".
 *   - tests/phase10-saas.test.ts: backup sweep FAILED (same swap mid-sweep).
 *
 * The fix: test mode resolves secrets SYNCHRONOUSLY from deterministic
 * material (deterministicTestSecret in src/lib/config.ts) — identical in every
 * process, so no swap can invalidate anything. These tests pin that contract:
 * determinism, cross-"restart" (cache reset) readability, and stability across
 * the first-use window.
 */
import "./queue-test-env";
import { describe, test, expect } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

import {
  getAuthSecret,
  getTrackingWebhookSecret,
  getIntegrationEncryptionKey,
  __resetEncryptionKeyCacheForTests,
} from "../src/lib/config";
import { encryptCredentials, decryptCredentials } from "../src/lib/crypto";

// The test harness (scripts/run-tests.ts TEST_SECRETS) provides
// TRACKING_WEBHOOK_SECRET for the SERVER process; when run per-file, the env
// var is inherited here and legitimately wins over the deterministic
// derivation. Remove it in THIS file's process so the fallback contract can
// be pinned (bun runs every test file in its own process, so this is safe).
delete process.env.TRACKING_WEBHOOK_SECRET;

/** Reference implementation of the documented test-mode derivation. */
function refTestSecret(purpose: string): string {
  return createHash("sha256").update(`stayloop-test:${purpose}`).digest("hex");
}

function seal(key: Buffer, plaintext: string): string {
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(
    ".",
  );
}

function open(key: Buffer, blob: string): string {
  const [iv, ct, tag] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

describe("config secret resolution — no async-adoption race (2026-10 regression)", () => {
  test("test-mode secrets are deterministic (NOT per-PID fallbacks)", () => {
    // A per-PID fallback would differ from the reference derivation; the
    // deterministic contract is what makes tokens/ciphertext verifiable across
    // processes (test runner children, dev server, watchdog restarts).
    expect(getAuthSecret()).toBe(refTestSecret("auth"));
    expect(getTrackingWebhookSecret()).toBe(refTestSecret("webhook"));
  });

  test("encryption key is stable across the first-use window (no swap lands)", async () => {
    // Exact ops-reliability failure scenario: first resolution, then let any
    // pending async resolution land, then re-read.
    __resetEncryptionKeyCacheForTests();
    const k0 = getIntegrationEncryptionKey();
    const blob = seal(k0, "race-regression-payload");
    await new Promise((r) => setTimeout(r, 25)); // microtasks + timers drain
    const k1 = getIntegrationEncryptionKey();
    expect(k1.equals(k0)).toBe(true);
    expect(open(k1, blob)).toBe("race-regression-payload");
  });

  test("ciphertext survives a simulated process restart (cache reset)", () => {
    // Exact recheck-fixes / phase10-saas scenario: credentials written by one
    // process must be decryptable by a fresh one (same deterministic key).
    __resetEncryptionKeyCacheForTests();
    const tenant = { hotelId: "hotel-race", integrationType: "WHATSAPP" };
    const envelope = encryptCredentials(tenant, { token: "tok-race", phoneId: "123" });
    __resetEncryptionKeyCacheForTests(); // "restart" before reading
    expect(decryptCredentials(tenant, envelope)).toEqual({ token: "tok-race", phoneId: "123" });
  });

  test("session-token key material is identical before/after the first-use window", async () => {
    // Exact phase1 crash scenario: a token signed at login must verify on the
    // NEXT request even if an async dev-secret resolution lands in between.
    const before = getAuthSecret();
    const token = createHmac("sha256", before).update("token-body").digest("base64url");
    await new Promise((r) => setTimeout(r, 25));
    const after = getAuthSecret();
    expect(after).toBe(before);
    expect(createHmac("sha256", after).update("token-body").digest("base64url")).toBe(token);
  });

  test("deterministic key derivation matches the persisted-dev-secret material", () => {
    // Pins the mirror contract between deterministicTestSecret() and
    // getOrCreateDevSecret()'s STAYLOOP_TEST branch: if either changes without
    // the other, cross-process verification silently breaks again.
    const expected = createHash("sha256")
      .update(`stayloop-integrations:${refTestSecret("integration-key")}`)
      .digest();
    __resetEncryptionKeyCacheForTests();
    expect(getIntegrationEncryptionKey().equals(expected)).toBe(true);
  });
});
