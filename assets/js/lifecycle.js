/**
 * What a proposal's numbers mean: where it is in its life, whether someone
 * should follow it up, and the period figures on the dashboard.
 *
 * Shared by the dashboard (assets/js/dashboard.js) and the server's CSV export
 * (api/export.js), so the file a person downloads says exactly what the screen
 * said. Pure: rows in (one per proposal, from texc_overview), answers out.
 * `now` is always passed in, so a test can stand on any day. Calendar days are
 * Hobart days.
 */

export const TZ = 'Australia/Hobart';
const DAY = 86400000;

/* ------------------------------------------------------------------ dates */

const partsFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Hobart calendar date of an instant, as 'YYYY-MM-DD'. */
export function hobartDate(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const utc = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

export function addDays(ymd, n) {
  return new Date(utc(ymd) + n * DAY).toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b later is positive). */
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);

/** Whole days since an instant, by the clock (not the calendar). */
const daysSince = (t, now) => Math.floor((now.getTime() - new Date(t).getTime()) / DAY);

const longFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** '13 Oct 2026' — for a 'YYYY-MM-DD' (taken as is) or an instant (its Hobart day). */
export function dayLabel(v) {
  if (!v) return '';
  const ymd = YMD_RE.test(String(v)) ? String(v) : hobartDate(v);
  return ymd ? longFmt.format(new Date(utc(ymd))) : '';
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * The states, in the order a proposal usually moves through them, with the
 * words staff see. `tone` picks the badge style; the dashboard always pairs it
 * with an icon and the label, never colour alone.
 */
export const STATES = Object.freeze({
  draft: { label: 'Draft', icon: 'pen-line', tone: 'quiet' },
  issued: { label: 'Issued', icon: 'send', tone: 'neutral' },
  opened: { label: 'Opened', icon: 'eye', tone: 'neutral' },
  engaged: { label: 'Engaged', icon: 'activity', tone: 'neutral' },
  changes: { label: 'Changes requested', icon: 'message-square', tone: 'caution' },
  accepted: { label: 'Accepted', icon: 'check-circle', tone: 'go' },
  expired: { label: 'Expired', icon: 'clock', tone: 'quiet' },
  withdrawn: { label: 'Withdrawn', icon: 'circle-x', tone: 'stop' },
  archived: { label: 'Archived', icon: 'archive', tone: 'quiet' },
});

/** A session is a browser tab's visit; three or more is someone coming back to it. */
export const ENGAGED_SESSIONS = 3;

const expiredAt = (r, now) => (r.link_expires_at && new Date(r.link_expires_at) <= now)
  || (YMD_RE.test(String(r.valid_until || '')) && r.valid_until < hobartDate(now));

/**
 * One state per proposal. Precedence, first match wins:
 * archived > withdrawn > draft > accepted > expired > changes requested >
 * engaged > opened > issued. Everything after "draft" is about the CURRENT
 * revision: a client who read revision A has not yet opened revision B.
 */
export function stateOf(r, now) {
  if (r.archived_at) return 'archived';
  if (r.status === 'withdrawn') return 'withdrawn';
  if (r.status === 'draft' || !r.rev) return 'draft';
  if (r.current_accepted_at) return 'accepted';
  if (expiredAt(r, now)) return 'expired';
  if (r.changes_requested_at) return 'changes';
  if ((r.docs_opened_current || 0) > 0 || (r.options_current || 0) > 0 || (r.sessions_current || 0) >= ENGAGED_SESSIONS) return 'engaged';
  if ((r.views_current || 0) > 0) return 'opened';
  return 'issued';
}

/** Accepted on an earlier revision, revised since, and the new one not yet accepted. */
export const needsReacceptance = (r) => !!(r.last_accepted_rev && !r.current_accepted_at && r.status === 'issued' && !r.archived_at);

/** Still out with the client and could yet be accepted. */
export const isOpen = (state) => ['issued', 'opened', 'engaged', 'changes'].includes(state);

/* ------------------------------------------------------------------ follow-ups */

export const FOLLOW_UP = Object.freeze({ unopenedDays: 5, quietDays: 3, expiringDays: 7, documentDays: 14 });

/**
 * Why a proposal needs a person to pick up the phone, most pressing first.
 * Empty when it does not. Practice proposals (is_test) never ask.
 */
export function followUps(r, now) {
  if (r.is_test) return [];
  const state = stateOf(r, now);
  const out = [];
  const today = hobartDate(now);
  if (state === 'changes') out.push({ kind: 'changes', text: `Asked for changes ${dayLabel(r.changes_requested_at)}` });
  if (needsReacceptance(r) && !expiredAt(r, now)) out.push({ kind: 'reaccept', text: `Revised after acceptance of ${r.last_accepted_rev}: needs accepting again` });
  if (!isOpen(state)) return out;
  if (YMD_RE.test(String(r.valid_until || ''))) {
    const left = daysBetween(today, r.valid_until);
    if (left >= 0 && left <= FOLLOW_UP.expiringDays) out.push({ kind: 'expiring', text: left === 0 ? 'Valid until today' : `Valid for ${left} more ${left === 1 ? 'day' : 'days'}` });
  }
  // A document the current revision sent lapses (Phase 8): the client may be deciding on an expired certificate.
  if (YMD_RE.test(String(r.docs_expire_on || ''))) {
    const left = daysBetween(today, r.docs_expire_on);
    if (left <= FOLLOW_UP.documentDays) {
      out.push({ kind: 'document', text: left < 0 ? `A document it sent expired on ${dayLabel(r.docs_expire_on)}` : left === 0 ? 'A document it sent expires today' : `A document it sent expires in ${left} ${left === 1 ? 'day' : 'days'}` });
    }
  }
  if (!(r.views_current > 0) && r.rev_published_at) {
    const n = daysSince(r.rev_published_at, now);
    if (n >= FOLLOW_UP.unopenedDays) out.push({ kind: 'unopened', text: `Not opened ${n} days after it was sent` });
  } else if (r.last_view_current && state !== 'changes') {
    const n = daysSince(r.last_view_current, now);
    if (n >= FOLLOW_UP.quietDays) out.push({ kind: 'quiet', text: `Opened, then quiet for ${n} days` });
  }
  return out;
}

/* ------------------------------------------------------------------ periods and figures */

export const PERIODS = Object.freeze({
  '30d': 'Last 30 days',
  quarter: 'This quarter',
  fy: 'This financial year',
  '12m': 'Last 12 months',
  all: 'All time',
});

/** The first Hobart day of a period (inclusive), or '' for all time. */
export function periodStart(key, now) {
  const today = hobartDate(now);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  switch (key) {
    case '30d': return addDays(today, -29);
    case 'quarter': return first(y, m - ((m - 1) % 3));
    case 'fy': return first(m >= 7 ? y : y - 1, 7);
    case '12m': { const back = m - 11; return back >= 1 ? first(y, back) : first(y - 1, back + 12); }
    default: return '';
  }
}

export function periodLabel(key, now) {
  const from = periodStart(key, now);
  return from ? `${dayLabel(from)} to ${dayLabel(hobartDate(now))}` : 'Since the first proposal';
}

const counts = (r) => !r.is_test;
const sum = (rows, f) => rows.reduce((t, r) => t + (Number.isSafeInteger(Number(f(r))) ? Number(f(r)) : 0), 0);

/**
 * The period's figures, for proposals FIRST ISSUED in the period (a cohort, so
 * the win rate compares like with like): how many went out, how many have been
 * accepted so far, and what those were worth. Win rate leaves out proposals
 * that were withdrawn, and practice proposals never count. The open pipeline
 * is "right now", whatever the period.
 */
export function figures(rows, key, now) {
  const from = periodStart(key, now);
  const cohort = rows.filter((r) => counts(r) && r.issued_at && (!from || hobartDate(r.issued_at) >= from));
  const accepted = cohort.filter((r) => r.first_accepted_at);
  const withdrawn = cohort.filter((r) => r.status === 'withdrawn' && !r.first_accepted_at).length;
  const base = cohort.length - withdrawn;
  const open = rows.filter((r) => counts(r) && isOpen(stateOf(r, now)));
  return {
    issued: cohort.length,
    accepted: accepted.length,
    withdrawn,
    winRate: base > 0 ? accepted.length / base : null,
    acceptedValueCents: sum(accepted, (r) => r.last_accepted_subtotal_cents),
    pipelineCount: open.length,
    pipelineValueCents: sum(open, (r) => r.value_cents),
  };
}

/**
 * Issued and accepted, counted by Hobart month, for the last `months` months
 * ending with this one. A proposal counts as issued in the month it first went
 * out and as accepted in the month it was first accepted.
 */
export function monthly(rows, now, months = 12) {
  const today = hobartDate(now);
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const keys = [];
  for (let i = 0; i < months; i += 1) {
    keys.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  const bucket = new Map(keys.map((k) => [k, { key: k, issued: 0, accepted: 0 }]));
  for (const r of rows) {
    if (!counts(r)) continue;
    const i = r.issued_at && bucket.get(hobartDate(r.issued_at).slice(0, 7));
    if (i) i.issued += 1;
    const a = r.first_accepted_at && bucket.get(hobartDate(r.first_accepted_at).slice(0, 7));
    if (a) a.accepted += 1;
  }
  const short = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'short' });
  const long = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  return keys.map((k) => {
    const at = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1));
    return { ...bucket.get(k), label: short.format(at), longLabel: long.format(at), year: Number(k.slice(0, 4)) };
  });
}

/* ------------------------------------------------------------------ the list */

export const SORTS = Object.freeze({
  activity: 'Latest activity',
  issued: 'Most recently issued',
  valid: 'Valid until (soonest)',
  value: 'Value (highest)',
});

/**
 * The list as filtered on screen and in the export:
 *   f.ids      search result (a Set of ids), or null for no search
 *   f.state    '' (everything not archived), a STATES key, or 'followup'
 *   f.region   a site region, or ''
 *   f.service  a service slug, or ''
 *   f.sort     a SORTS key
 * Archived proposals appear only when f.state is 'archived'.
 */
export function listRows(rows, f, now) {
  const state = f.state || '';
  const out = [];
  for (const r of rows) {
    const s = stateOf(r, now);
    if (f.ids && !f.ids.has(r.id)) continue;
    if (state === 'archived' ? s !== 'archived' : s === 'archived') continue;
    if (state && state !== 'archived' && state !== 'followup' && s !== state) continue;
    const fu = followUps(r, now);
    if (state === 'followup' && (!fu.length || s === 'archived')) continue;
    if (f.region && r.site_region !== f.region) continue;
    if (f.service && !(Array.isArray(r.services) && r.services.includes(f.service))) continue;
    out.push({ ...r, state: s, followUps: fu });
  }
  const t = (v) => (v ? new Date(v).getTime() : 0);
  const by = {
    activity: (a, b) => t(b.updated_at) - t(a.updated_at),
    issued: (a, b) => t(b.issued_at) - t(a.issued_at) || t(b.updated_at) - t(a.updated_at),
    valid: (a, b) => String(a.valid_until || '9999').localeCompare(String(b.valid_until || '9999')) || t(b.updated_at) - t(a.updated_at),
    value: (a, b) => (Number(b.value_cents) || 0) - (Number(a.value_cents) || 0) || t(b.updated_at) - t(a.updated_at),
  }[SORTS[f.sort] ? f.sort : 'activity'];
  return out.sort(by);
}

/** Every proposal that needs following up, most pressing reason first. */
export function followUpList(rows, now) {
  const rank = { changes: 0, reaccept: 1, expiring: 2, document: 3, unopened: 4, quiet: 5 };
  return rows
    .filter((r) => !r.archived_at)
    .map((r) => ({ ...r, state: stateOf(r, now), followUps: followUps(r, now) }))
    .filter((r) => r.followUps.length)
    .sort((a, b) => rank[a.followUps[0].kind] - rank[b.followUps[0].kind] || String(a.valid_until || '9999').localeCompare(String(b.valid_until || '9999')));
}

/** The regions and services that actually occur, for the filter menus. */
export function facets(rows) {
  const regions = new Set();
  const services = new Set();
  for (const r of rows) {
    if (r.site_region) regions.add(r.site_region);
    for (const s of Array.isArray(r.services) ? r.services : []) services.add(s);
  }
  return { regions: [...regions].sort(), services: [...services].sort() };
}

/* ------------------------------------------------------------------ deleting for good */

/** An archived proposal can be deleted permanently (by Brand in Black) this many days after archiving. The database holds the same number. */
export const PURGE_AFTER_DAYS = 90;

/** The first instant it may be deleted, or null while it is not archived. */
export const purgeableFrom = (r) => (r && r.archived_at ? new Date(new Date(r.archived_at).getTime() + PURGE_AFTER_DAYS * DAY) : null);

/**
 * Until when an accepted proposal is kept (Phase 9): the keeping period TEXC
 * sets (retention.keepAcceptedYears), from its last acceptance. Null while no
 * period is set: then it is kept for good. texc_purge() holds the same rule.
 */
export function keptUntil(acceptedAts, retention) {
  const years = retention && Number.isInteger(retention.keepAcceptedYears) && retention.keepAcceptedYears >= 1 ? retention.keepAcceptedYears : null;
  const times = (acceptedAts || []).map((x) => Date.parse(x)).filter(Number.isFinite);
  if (!years || !times.length) return null;
  const until = new Date(Math.max(...times));
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}

/** The name a row is shown by: its project, or what it is while it has none. */
export const titleOf = (r) => r.project || (r.reference ? `Proposal ${r.reference}` : 'Untitled draft');
