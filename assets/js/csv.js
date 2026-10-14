/**
 * One spreadsheet cell, the one way this system writes them: the dashboard's
 * CSV export (lib/report.js) and the record pack's history (record-pack.js).
 *
 * A cell a spreadsheet would read as a formula — one starting =, +, -, @, a
 * tab or a carriage return — is written with a leading apostrophe, so a client
 * name like "=HYPERLINK(…)" arrives as text, never as something that runs.
 * Every cell is quoted.
 */
export function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Rows to a CSV file's text: CRLF line ends, a byte-order mark so Excel reads UTF-8. */
export const csvText = (rows) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
