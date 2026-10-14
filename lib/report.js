/**
 * The dashboard's list as a spreadsheet (CSV), built from the same rows and
 * the same rules as the screen (assets/js/lifecycle.js).
 *
 * A cell a spreadsheet would read as a formula — one starting =, +, -, @, a
 * tab or a carriage return — is written with a leading apostrophe, so a client
 * name like "=HYPERLINK(…)" arrives as text, never as something that runs
 * (assets/js/csv.js, the one rule, shared with the record pack's history).
 * Every cell is quoted; lines end CRLF; the file starts with a byte-order mark
 * so Excel reads it as UTF-8.
 */
import { STATES, hobartDate, titleOf } from '../assets/js/lifecycle.js';
import { DOC_TYPES } from '../assets/js/schema.js';
import { cell } from '../assets/js/csv.js';

export { cell };

const dollars = (cents) => (Number.isSafeInteger(Number(cents)) && cents !== null && cents !== '' ? (Number(cents) / 100).toFixed(2) : '');
const ymd = (v) => (v ? hobartDate(v) : '');

export const COLUMNS = [
  ['Reference', (r) => r.reference || ''],
  ['Revision', (r) => r.rev || ''],
  ['Project', (r) => titleOf(r)],
  ['Client', (r) => r.client_company],
  ['Contact', (r) => r.contact],
  ['Locality', (r) => r.site_locality],
  ['Region', (r) => r.site_region],
  ['Services', (r, ctx) => (Array.isArray(r.services) ? r.services.map((s) => ctx.services[s] || s).join('; ') : '')],
  ['Document type', (r) => DOC_TYPES[r.doc_type] || r.doc_type || ''],
  ['State', (r) => (STATES[r.state] ? STATES[r.state].label : r.state)],
  ['Follow up', (r) => (r.followUps || []).map((f) => f.text).join('; ')],
  ['First issued', (r) => ymd(r.issued_at)],
  ['Current revision issued', (r) => ymd(r.rev_published_at)],
  ['Valid until', (r) => r.valid_until || ''],
  ['Value ex GST (priced items)', (r) => dollars(r.value_cents)],
  ['Opens of current revision', (r) => (r.rev ? Number(r.views_current) || 0 : '')],
  ['Last opened', (r) => ymd(r.last_opened_at)],
  ['Accepted (current revision)', (r) => ymd(r.current_accepted_at)],
  ['Accepted by', (r) => r.current_accepted_by || ''],
  ['Accepted value ex GST', (r) => (r.current_accepted_at ? dollars(r.current_accepted_subtotal_cents) : '')],
  ['Archived', (r) => ymd(r.archived_at)],
  ['Archive reason', (r) => r.archive_reason || ''],
  ['Practice proposal', (r) => (r.is_test ? 'Yes' : '')],
];

export function toCsv(rows, ctx) {
  const lines = [COLUMNS.map(([h]) => cell(h)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(([, f]) => cell(f(r, ctx))).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** e.g. "proposals-2026-10-13.csv", prefixed with the brand's short name. */
export const csvName = (brandName, now) => `${String(brandName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-proposals-${hobartDate(now)}.csv`;

