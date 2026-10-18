import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state: { queries: Array<Record<string, any>> } = { queries: [] };
const catalog = [
  {
    id: "tea",
    name: "Masala Tea",
    priceMinor: 100,
    currency: "INR",
    available: true,
    category: { active: true },
    optionGroups: [],
  },
  {
    id: "coffee",
    name: "Filter Coffee",
    priceMinor: 200,
    currency: "INR",
    available: true,
    category: { active: true },
    optionGroups: [
      {
        id: "size-group",
        name: "Size",
        required: true,
        minSelect: 1,
        maxSelect: 1,
        options: [{ id: "large", name: "Large", priceDeltaMinor: 50 }],
      },
    ],
  },
];

mock.module("@/lib/db", () => ({
  db: {
    menuItem: {
      findMany: async (args: Record<string, any>) => {
        state.queries.push(args);
        const ids = args.where.id.in as string[];
        return catalog.filter((item) => ids.includes(item.id));
      },
    },
  },
}));

const { CartValidationError, priceCart } = await import("../src/lib/orders");
const ROOT = join(import.meta.dir, "..");

beforeEach(() => {
  state.queries = [];
});

describe("menu item query batching", () => {
  test("priceCart fetches distinct cart items with one catalog query", async () => {
    const priced = await priceCart("hotel-1", [
      { menuItemId: "tea", quantity: 2 },
      { menuItemId: "tea", quantity: 1 },
      { menuItemId: "coffee", quantity: 1, optionIds: ["large"] },
    ]);

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].where).toEqual({ id: { in: ["tea", "coffee"] }, hotelId: "hotel-1", active: true });
    expect(priced.lines).toHaveLength(3);
    expect(priced.subtotalMinor).toBe(550);
  });

  test("quantity validation still happens before the catalog query", async () => {
    try {
      await priceCart("hotel-1", [{ menuItemId: "tea", quantity: 0 }]);
      throw new Error("expected priceCart to reject the quantity");
    } catch (error) {
      expect(error).toBeInstanceOf(CartValidationError);
      expect((error as InstanceType<typeof CartValidationError>).code).toBe("QUANTITY_INVALID");
    }
    expect(state.queries).toHaveLength(0);
  });

  test("bill aggregation also uses a single batched menu-item lookup", () => {
    const source = readFileSync(join(ROOT, "src/lib/billing.ts"), "utf8");
    expect(source).toContain("const menuItemCategories: Array<{ id: string; categoryId: string | null }> = menuItemIds.length");
    expect(source).toContain("await db.menuItem.findMany({");
    expect(source).not.toContain("db.menuItem.findUnique");
  });
});
