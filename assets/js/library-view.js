/**
 * How a library document stands, worded once for the Documents page and the
 * editor (lib/library.js is the server's half; assets/js/checks.js decides
 * what blocks publishing). Pure: a document as api/library.js lists it, and
 * today in Hobart, in; a standing out.
 */

/** A certificate this close to lapsing is flagged on the Documents page. */
export const EXPIRING_DAYS = 60;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2027-06-30 → 30 June 2027. */
export const dayAu = (iso) => { const [y, m, d] = String(iso || '').split('-').map(Number); return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : ''; };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const RELEASED = new Set(['clean', 'override']);

/**
 * { key, text, urgent } — key is one of retired, expired, expiring, current,
 * awaiting (a checked file waits for approval), refused (a file the check did
 * not pass waits for a decision), none (no file yet).
 */
export function standing(item, today) {
  if (item.retiredAt) return { key: 'retired', text: 'Retired', urgent: false };
  const cur = item.current;
  if (!cur) {
    const waiting = (item.versions || []).filter((v) => !v.approvedAt);
    if (waiting.some((v) => RELEASED.has(v.status))) return { key: 'awaiting', text: 'A file is waiting for approval', urgent: true };
    if (waiting.some((v) => v.status === 'rejected' || v.status === 'cannot-verify')) return { key: 'refused', text: 'Its file did not pass the check', urgent: true };
    return { key: 'none', text: 'No approved file yet', urgent: true };
  }
  if (cur.expiresOn) {
    const left = daysBetween(today, cur.expiresOn);
    if (left < 0) return { key: 'expired', text: `Expired on ${dayAu(cur.expiresOn)}`, urgent: true };
    if (left <= EXPIRING_DAYS) return { key: 'expiring', text: left === 0 ? 'Expires today' : `Expires in ${left} ${left === 1 ? 'day' : 'days'} (${dayAu(cur.expiresOn)})`, urgent: true };
    return { key: 'current', text: `Current to ${dayAu(cur.expiresOn)}`, urgent: false };
  }
  return { key: 'current', text: 'Does not expire', urgent: false };
}

/** A newer file waiting for approval while an older one is current (a renewal in progress). */
export const renewalWaiting = (item) => !!item.current && (item.versions || []).some((v) => !v.approvedAt && RELEASED.has(v.status));

/** Whose it is, in words. */
export function ownerName(item, people, organisation) {
  if (item.ownerKind === 'organisation') return organisation;
  const p = (people || []).find((x) => x.slug === item.ownerRef);
  return p ? p.name : item.ownerRef;
}

/** The checklist's view of the library (assets/js/checks.js ctx.evidence), from the list api/library.js sends. */
export function evidenceFromList(items) {
  return Object.fromEntries((items || []).map((i) => [i.id, {
    title: i.title, retired: !!i.retiredAt,
    current: i.current ? { status: i.current.status, expiresOn: i.current.expiresOn || null } : null,
  }]));
}
