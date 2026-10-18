/** Isolated behavioral tests with an in-memory Prisma boundary; no DB connectivity claimed. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type User = {
  email: string;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaBackupCodes: string | null;
  mfaLastUsedStep: number | null;
};
let user: User;
let beforeUpdate: (() => void) | undefined;
const database = {
  user: {
    findUnique: async () => ({ ...user }),
    update: async ({ data }: { data: Partial<User> }) => {
      beforeUpdate?.();
      Object.assign(user, data);
      return { ...user };
    },
    updateMany: async ({ where, data }: { where: Partial<User>; data: Partial<User> }) => {
      beforeUpdate?.();
      if (where.mfaEnabled !== undefined && where.mfaEnabled !== user.mfaEnabled)
        return { count: 0 };
      if (where.mfaSecret !== undefined && where.mfaSecret !== user.mfaSecret) return { count: 0 };
      Object.assign(user, data);
      return { count: 1 };
    },
  },
};
mock.module("../src/lib/db", () => ({ db: database }));
mock.module("../src/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
mock.module("../src/lib/config", () => ({
  getAuthSecret: () => "isolated-mfa-test-secret-not-a-real-credential",
}));
const { beginMfaSetup, confirmMfaSetup, disableMfa, regenerateBackupCodes, generateTotp } = await import("../src/lib/mfa");

beforeEach(() => {
  user = {
    email: "test@example.invalid",
    mfaEnabled: false,
    mfaSecret: null,
    mfaBackupCodes: null,
    mfaLastUsedStep: null,
  };
  beforeUpdate = undefined;
});

describe("MFA enrollment must not bypass step-up verification", () => {
  test("an enabled factor cannot be replaced just by starting setup", async () => {
    user.mfaEnabled = true;
    user.mfaSecret = "existing-encrypted-factor";
    await expect(beginMfaSetup("user-1")).rejects.toThrow();
    expect(user.mfaEnabled).toBe(true);
    expect(user.mfaSecret).toBe("existing-encrypted-factor");
  });

  test("setup cannot overwrite a factor enabled while the QR was rendering", async () => {
    beforeUpdate = () => {
      user.mfaEnabled = true;
      user.mfaSecret = "concurrently-enabled-factor";
    };
    await expect(beginMfaSetup("user-1")).rejects.toThrow();
    expect(user.mfaEnabled).toBe(true);
    expect(user.mfaSecret).toBe("concurrently-enabled-factor");
  });

  test("valid enrollment succeeds; invalid confirmation does not enable MFA", async () => {
    const setup = await beginMfaSetup("user-1");
    expect(user.mfaEnabled).toBe(false);
    expect((await confirmMfaSetup("user-1", "invalid")).ok).toBe(false);
    const result = await confirmMfaSetup("user-1", generateTotp(setup.secret));
    expect(result.ok).toBe(true);
    expect(user.mfaEnabled).toBe(true);
    if (result.ok) expect(result.backupCodes).toHaveLength(10);
  });

  test("confirmation cannot enable an unverified replacement secret", async () => {
    const setup = await beginMfaSetup("user-1");
    beforeUpdate = () => {
      user.mfaSecret = "replacement-factor";
    };
    expect((await confirmMfaSetup("user-1", generateTotp(setup.secret))).ok).toBe(false);
    expect(user.mfaEnabled).toBe(false);
  });

  test("concurrent confirmations have exactly one winner", async () => {
    const setup = await beginMfaSetup("user-1");
    const code = generateTotp(setup.secret);
    const results = await Promise.all([
      confirmMfaSetup("user-1", code),
      confirmMfaSetup("user-1", code),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("disable does not clear a different factor installed after step-up verification", async () => {
    const setup = await beginMfaSetup("user-1");
    expect((await confirmMfaSetup("user-1", generateTotp(setup.secret))).ok).toBe(true);
    let updates = 0;
    beforeUpdate = () => {
      updates += 1;
      if (updates === 2) user.mfaSecret = "concurrently-replaced-factor";
    };
    const result = await disableMfa("user-1", generateTotp(setup.secret));
    expect(result.ok).toBe(false);
    expect(user.mfaEnabled).toBe(true);
    expect(user.mfaSecret).toBe("concurrently-replaced-factor");
  });

  test("backup-code rotation cannot write codes after MFA is concurrently disabled", async () => {
    const setup = await beginMfaSetup("user-1");
    expect((await confirmMfaSetup("user-1", generateTotp(setup.secret))).ok).toBe(true);
    const existingCodes = user.mfaBackupCodes;
    let updates = 0;
    beforeUpdate = () => {
      updates += 1;
      if (updates === 2) user.mfaEnabled = false;
    };
    const result = await regenerateBackupCodes("user-1", generateTotp(setup.secret));
    expect(result.ok).toBe(false);
    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaBackupCodes).toBe(existingCodes);
  });
});
