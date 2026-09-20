/** RFC 4180 CSV: quote when a field could otherwise be misread, escape quotes by doubling. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  // A leading =, +, - or @ is a formula to a spreadsheet; a leading apostrophe is
  // not, and is what every exporter that has met this problem writes.
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Header row plus one row per record, CRLF-terminated as the RFC asks. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [csvRow(columns), ...rows.map((row) => csvRow(columns.map((c) => row[c])))];
  return `${lines.join("\r\n")}\r\n`;
}
