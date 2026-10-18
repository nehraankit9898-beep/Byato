import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

mock.module("@/lib/db", () => ({ db: {} }));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
const { generateCouponCode } = await import("../src/lib/coupons");

const ROOT = join(import.meta.dir, "..");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

describe("coupon code generation", () => {
  test("generates six characters from the unambiguous coupon alphabet", () => {
    const code = generateCouponCode();
    expect(code).toMatch(/^STAY-[A-Z2-9]{6}$/);
    for (const char of code.slice(-6)) expect(ALPHABET).toContain(char);
  });

  test("uses a cryptographic bounded random source, not Math.random", () => {
    const source = readFileSync(join(ROOT, "src/lib/coupons.ts"), "utf8");
    expect(source).toContain('import { randomInt } from "crypto"');
    expect(source).toContain("chars[randomInt(chars.length)]");
    expect(source).not.toContain("Math.random");
  });
});
