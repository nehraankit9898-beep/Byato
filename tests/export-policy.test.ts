import { describe, expect, test } from "bun:test";
import { shouldQueueCsvExport } from "../src/lib/export-policy";

describe("CSV export inline-size policy", () => {
  test("allows inline export at the configured row limit", () => {
    expect(shouldQueueCsvExport(5000, 5000)).toBe(false);
  });

  test("queues exports above the configured row limit", () => {
    expect(shouldQueueCsvExport(5001, 5000)).toBe(true);
  });

  test("does not queue exports below the configured row limit", () => {
    expect(shouldQueueCsvExport(4999, 5000)).toBe(false);
  });

  test("queues any dataset above a small configured limit", () => {
    expect(shouldQueueCsvExport(100, 25)).toBe(true);
  });
});
