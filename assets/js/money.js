/**
 * Quote arithmetic. The browser and the server import this same file, so the
 * total a client sees and the total the server records on acceptance cannot
 * disagree.
 *
 * Rules (docs/architecture.md §3, row 16):
 *   - money is integer cents; quantity is integer hundredths (2.5 h = 250)
 *   - a line rounds half-up once: amount = round(qtyHundredths × rateCents ÷ 100)
 *   - GST is 10% of the subtotal, rounded half-up once
 *   - an "at cost" line with no rate is shown, never summed
 *   - an optional line counts only when ticked
 * Nothing here touches floating point except the final display formatting.
 */

export const BASES = Object.freeze({
  hourly: 'Hourly',
  daily: 'Daily',
  'per-shift': 'Per shift',
  'lump-sum': 'Lump sum',
  'at-cost': 'At cost',
  'provisional-sum': 'Provisional sum',
});

export const GST_PERCENT = 10;

function isCount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Amount of one line in cents, or null when it has no amount (at cost, unpriced). */
export function lineAmountCents(line) {
  if (!line || line.rateCents == null) return null;
  const qty = line.qtyHundredths == null ? 100 : line.qtyHundredths;
  if (!isCount(qty) || !isCount(line.rateCents)) throw new Error('Quote line has a non-integer or negative quantity or rate');
  const product = qty * line.rateCents;
  if (!Number.isSafeInteger(product)) throw new Error('Quote line is too large');
  return Math.floor((product + 50) / 100);
}

/**
 * Totals for a set of lines.
 * @param {Array} lines
 * @param {Set<string>|string[]} chosen ids of optional lines the client has ticked
 */
export function quoteTotals(lines, chosen = []) {
  const picked = chosen instanceof Set ? chosen : new Set(chosen);
  let subtotal = 0;
  let unpriced = 0;
  const included = [];
  for (const line of lines || []) {
    if (line.optional && !picked.has(line.id)) continue;
    const amount = lineAmountCents(line);
    if (amount == null) { unpriced += 1; continue; }
    subtotal += amount;
    included.push(line.id);
  }
  if (!Number.isSafeInteger(subtotal)) throw new Error('Quote total is too large');
  const gst = Math.floor((subtotal * GST_PERCENT + 50) / 100);
  return { subtotal, gst, total: subtotal + gst, unpriced, included };
}

const groupAU = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });

/** 123456 -> "$1,234.56". Integer maths; Intl only groups the dollars. */
export function formatAUD(cents) {
  if (!Number.isSafeInteger(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return (neg ? '−' : '') + '$' + groupAU.format(dollars) + '.' + rest;
}

/** 250 -> "2.5", 4000 -> "40", 1 -> "0.01". */
export function formatQty(hundredths) {
  if (!isCount(hundredths)) return '';
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  if (!frac) return groupAU.format(whole);
  return groupAU.format(whole) + '.' + String(frac).padStart(2, '0').replace(/0$/, '');
}
