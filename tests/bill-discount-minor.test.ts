import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/db", () => ({ db: {} }));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
const { computeDiscountMinor } = await import("../src/lib/coupons");

const coupon = (overrides: Partial<Parameters<typeof computeDiscountMinor>[0]> = {}) => ({
  discountType: "PERCENTAGE",
  discountValue: 10,
  maximumDiscount: null,
  ...overrides,
});

describe("bill coupon discounts in minor units", () => {
  test("percentage discounts use basis-point integer math and half-up paise rounding", () => {
    expect(computeDiscountMinor(coupon({ discountValue: 10 }), 123)).toBe(12);
    expect(computeDiscountMinor(coupon({ discountValue: 1 }), 50)).toBe(1);
    expect(computeDiscountMinor(coupon({ discountValue: 0.99 }), 50)).toBe(0);
  });

  test("fixed discounts and maximum caps convert to minor units once", () => {
    expect(
      computeDiscountMinor(
        coupon({ discountType: "FIXED_AMOUNT", discountValue: 12.34 }),
        5000,
      ),
    ).toBe(1234);
    expect(
      computeDiscountMinor(
        coupon({ discountValue: 50, maximumDiscount: 1.25 }),
        10_000,
      ),
    ).toBe(125);
  });

  test("discount cannot exceed the subtotal or fall below zero", () => {
    expect(computeDiscountMinor(coupon({ discountValue: 100 }), 25)).toBe(25);
    expect(computeDiscountMinor(coupon({ discountValue: -10 }), 100)).toBe(0);
    expect(computeDiscountMinor(coupon({ discountType: "FIXED_AMOUNT", discountValue: 9 }), 0)).toBe(0);
  });
});
