/**
 * Retention (Phase 9, docs/architecture.md §20): how long TEXC keeps its
 * proposal records, in texc_settings under 'retention'.
 *
 *   archiveAfterDays   a proposal that ran out without being accepted, and has
 *                      had no change for this long either, is archived
 *                      automatically (daily, api/retention.js). Never deleted.
 *   keepAcceptedYears  an accepted proposal is kept at least this long after
 *                      its last acceptance; after that Brand in Black may delete
 *                      it like any other (lib/purge.js, texc_purge()).
 *
 * Both are TEXC's to set (open item C43). Unset — the default — nothing is
 * archived automatically and an accepted proposal is kept for good. A
 * proposal that was never accepted can be deleted 90 days after it was
 * archived (Phase 7), whatever is set here.
 */
import { rest, one, rpc } from './db.js';
import { recordAudit } from './events.js';

export const LIMITS = Object.freeze({ archiveAfterDays: [7, 3650], keepAcceptedYears: [1, 100] });

/** The settings as stored: { archiveAfterDays, keepAcceptedYears, updatedAt, updatedBy }, unset as null. */
export async function getRetention(d) {
  const row = await one(d, 'texc_settings?key=eq.retention&select=value,updated_at,updated_by');
  const v = (row && row.value) || {};
  const pick = (k) => (Number.isInteger(v[k]) && v[k] >= LIMITS[k][0] && v[k] <= LIMITS[k][1] ? v[k] : null);
  return { archiveAfterDays: pick('archiveAfterDays'), keepAcceptedYears: pick('keepAcceptedYears'), updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null };
}

/** New settings as staff gave them: a whole number in range, or blank for "not set". Returns { value } or { error }. */
export function cleanRetention(b) {
  const value = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const raw = b[k];
    if (raw === null || raw === undefined || raw === '') { value[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${k === 'archiveAfterDays' ? 'Archive after' : 'Keep accepted proposals for'}: a whole number from ${lo} to ${hi}, or leave it blank.` };
    value[k] = n;
  }
  return { value };
}

/** Change them: recorded in the staff audit first, with what they were. */
export async function setRetention(d, req, who, value) {
  const before = await getRetention(d);
  const logged = await recordAudit(d, req, who, 'retention_changed', { detail: {
    from: { archiveAfterDays: before.archiveAfterDays, keepAcceptedYears: before.keepAcceptedYears }, to: value,
  } });
  if (!logged) return { ok: false, status: 503, error: 'The change could not be recorded, so it was not made.' };
  const r = await rest(d, 'POST', 'texc_settings?on_conflict=key', { key: 'retention', value, updated_by: who.email, updated_at: new Date().toISOString() },
    { prefer: 'return=minimal,resolution=merge-duplicates' });
  if (!r.ok) return { ok: false, status: 503, error: 'The change could not be saved. Try again.' };
  return { ok: true, retention: await getRetention(d) };
}

/** The daily run: archive what has run out, as the settings say. Returns { archived: [ids], days } or null. */
export async function runRetention(d) {
  const r = await rpc(d, 'texc_auto_archive', { p: {} });
  return r.ok && r.json && Array.isArray(r.json.archived) ? r.json : null;
}
