/**
 * Decide whether a CSV export must use the background queue.
 *
 * This is a server-side resource-safety boundary. Request query parameters must
 * not be able to disable it for large datasets.
 */
export function shouldQueueCsvExport(totalRows: number, inlineMaxRows: number): boolean {
  return totalRows > inlineMaxRows;
}
