import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

const authSecret = "test-auth-secret-for-mfa-backup-tests";
const secretBase32 = "JBSWY3DPEHPK3PXP";
const userId = "legacy-mfa-user";
const oldCode = "ABCDEF012345";
const legacyHash = createHash("sha256").update(oldCode).digest("hex");
const state: { mfaBackupCodes: string; mfaLastUsedStep: number | null } = {
  mfaBackupCodes: "",
  mfaLastUsedStep: null,
};

function makeSecretEnvelope(): string {
  const key = createHash("sha256").update(`stayloop-mfa:${authSecret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("stayloop-mfa", "utf8"));
  const encrypted = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${encrypted.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

const secretEnvelope = makeSecretEnvelope();
mock.module("@/lib/config", () => ({ getAuthSecret: () => authSecret }));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: { MFA_CHANGED: "MFA_CHANGED" } }));
mock.module("@/lib/db", () => ({
  db: {
    user: {
      findUnique: async () => ({
        id: userId,
        mfaEnabled: true,
        mfaSecret: secretEnvelope,
        mfaBackupCodes: state.mfaBackupCodes,
        mfaLastUsedStep: state.mfaLastUsedStep,
      }),
      updateMany: async ({ data }: { data: { mfaBackupCodes?: string; mfaLastUsedStep?: number } }) => {
        if (data.mfaBackupCodes !== undefined) state.mfaBackupCodes = data.mfaBackupCodes;
        if (data.mfaLastUsedStep !== undefined) state.mfaLastUsedStep = data.mfaLastUsedStep;
        return { count: 1 };
      },
      update: async ({ data }: { data: { mfaBackupCodes: string } }) => {
        state.mfaBackupCodes = data.mfaBackupCodes;
        return { id: userId };
      },
    },
  },
}));

const { generateTotp, regenerateBackupCodes, verifyLoginCode } = await import("../src/lib/mfa");

beforeEach(() => {
  state.mfaBackupCodes = JSON.stringify([legacyHash]);
  state.mfaLastUsedStep = null;
});

describe("legacy MFA backup-code hashes", () => {
  test("unkeyed SHA-256 backup codes are rejected", async () => {
    expect(await verifyLoginCode(userId, oldCode)).toEqual({
      ok: false,
      error: "Invalid authentication code.",
    });
    expect(JSON.parse(state.mfaBackupCodes)).toEqual([legacyHash]);
  });

  test("the account can use TOTP to regenerate keyed codes and invalidate legacy hashes", async () => {
    const nextStepAt = (Math.floor(Date.now() / 30_000) + 1) * 30_000;
    const result = await regenerateBackupCodes(userId, generateTotp(secretBase32, nextStepAt));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.backupCodes).toHaveLength(10);
    expect(JSON.parse(state.mfaBackupCodes)).not.toContain(legacyHash);
    expect(await verifyLoginCode(userId, oldCode)).toMatchObject({ ok: false });
  });
});
