/**
 * A year of FICTIONAL proposals for the dashboard's captures and checks:
 * believable Tasmanian clients, sites, values and histories, written straight
 * into a LOCAL database the way twelve months of use would have left it.
 *
 *   seedDashboard(conn, { now })   → { ids: { <key>: <proposal id> }, count }
 *
 * Every client, contact and figure here is invented; none is a real job or a
 * real price. It runs only against the throwaway local stack
 * (scripts/demo/local-app.mjs) and refuses any other connection. Triggers are
 * paused for the one transaction (session_replication_role = replica) so rows
 * can carry the dates they would have had; nothing here could reach a hosted
 * database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { psql } from '../lib/local-supabase.mjs';
import { BRAND } from '../../lib/brand.js';
import { templateData } from '../../lib/template-data.js';
import { DOC_TYPES } from '../../assets/js/schema.js';

const DAY = 86400000;
const hex = (n) => randomBytes(n).toString('hex');
const slug = () => [...randomBytes(10)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

class TextArray { constructor(items) { this.items = items; } }

function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof TextArray) return `array[${v.items.map(lit).join(',')}]::text[]`;
  if (typeof v === 'object') return `${lit(JSON.stringify(v))}::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const insert = (table, row) => `insert into public.${table} (${Object.keys(row).join(', ')}) values (${Object.values(row).map(lit).join(', ')});`;

const STAFF = ['george@example.com', 'office@example.com'];
const DEVICES = ['Safari on iOS', 'Chrome on Windows', 'Chrome on Android', 'Edge on Windows', 'Safari on macOS'];

/*
 * One line per proposal. Days are days before `now`.
 *   revs      when each revision went out (A, B, …)
 *   valid     valid-until, days after the last revision
 *   opens     [[rev index, days ago, device], …] — a new session each
 *   docs      documents opened on the current revision; opts: optional items ticked
 *   accept    { rev, at, name, position }
 */
const PROPOSALS = [
  { key: 'ridgeway', client: 'Ashgrove Civil Pty Ltd', contact: 'Dana Whitfield', position: 'Project Manager', project: 'Ridgeway subdivision stage 3, rock excavation', locality: 'Riverside', region: 'Northern Tasmania', services: ['civil-construction'], value: 4186000, revs: [342], valid: 30, opens: [[0, 341, 0], [0, 339, 1], [0, 336, 1]], docs: 2, accept: { rev: 0, at: 335, name: 'Dana Whitfield', position: 'Project Manager' } },
  { key: 'bench4', client: 'Blackwood Ridge Quarries Pty Ltd', contact: 'Mick Russo', position: 'Quarry Manager', project: 'Bench 4 production blasting, winter campaign', locality: 'Deloraine', region: 'Northern Tasmania', services: ['quarry-mining'], value: 6240000, revs: [318, 309], revNote: 'Second blast pattern added at the client’s request.', valid: 30, opens: [[0, 317, 1], [0, 314, 1], [1, 308, 1]], docs: 3, opts: 1, accept: { rev: 1, at: 306, name: 'Mick Russo', position: 'Quarry Manager' } },
  { key: 'culvert', client: 'Coal River Constructions Pty Ltd', contact: 'Priya Nair', position: 'Site Engineer', project: 'Culvert footing rock removal', locality: 'Richmond', region: 'Southern Tasmania', services: ['civil-construction', 'microblasting'], value: 1192000, revs: [287], valid: 30, opens: [[0, 285, 2]], status: 'withdrawn', withdrawnAt: 270, withdrawNote: 'Client changed the design to avoid the rock; no blasting needed.' },
  { key: 'sandybay', client: 'Hollow Tree Homes Pty Ltd', contact: 'Tom Hadley', position: 'Director', project: 'Residential footings, controlled rock removal', locality: 'Sandy Bay', region: 'Southern Tasmania', services: ['microblasting'], value: 684000, revs: [262], valid: 30, opens: [[0, 260, 0], [0, 258, 0]], docs: 1, accept: { rev: 0, at: 255, name: 'Tom Hadley', position: 'Director' } },
  { key: 'latrobe', client: 'Mersey Bend Civil Pty Ltd', contact: 'Sarah Kemp', position: 'Contracts Administrator', project: 'Highway cutting widening, eastern batter', locality: 'Latrobe', region: 'North-West Tasmania', services: ['civil-construction'], value: 5375000, revs: [231, 222], revNote: 'Eastern batter in two stages; standby priced separately, as asked.', valid: 30, opens: [[0, 230, 1], [0, 229, 1], [1, 221, 1], [1, 220, 3]], docs: 2, opts: 2, changes: { rev: 0, at: 227, name: 'Sarah Kemp', message: 'Can you split the eastern batter into two stages and price standby separately? Our traffic management only allows closures on weekdays.' }, accept: { rev: 1, at: 219, name: 'Sarah Kemp', position: 'Contracts Administrator' } },
  { key: 'bellbay', client: 'Tamar Valley Earthworks Pty Ltd', contact: 'Lachlan Ward', position: 'Estimator', project: 'Industrial lot 12, bulk rock', locality: 'Bell Bay', region: 'Northern Tasmania', services: ['civil-construction'], value: 2890000, revs: [201], valid: 30, opens: [[0, 199, 1]], expired: true },
  { key: 'rosebery', client: 'Pieman Mining Services Pty Ltd', contact: 'Jess Morton', position: 'Superintendent', project: 'Relief shotfirer, six weeks of leave cover', locality: 'Rosebery', region: 'West Coast Tasmania', services: ['relief-shotfiring'], value: 3840000, revs: [176], valid: 21, opens: [[0, 176, 4], [0, 175, 1]], accept: { rev: 0, at: 174, name: 'Jess Morton', position: 'Superintendent' } },
  { key: 'fingal', client: 'Fingal Aggregates Pty Ltd', contact: 'Ben O’Keefe', position: 'Operations Manager', project: 'Shot sleeping, multi-shift firing', locality: 'Fingal', region: 'East Coast Tasmania', services: ['shot-sleeping'], value: 912000, revs: [150], valid: 30, opens: [[0, 149, 2], [0, 146, 2]], docs: 1, accept: { rev: 0, at: 144, name: 'Ben O’Keefe', position: 'Operations Manager' } },
  { key: 'huonville', client: 'Huon Pipeline Contracting Pty Ltd', contact: 'Chris Duval', position: 'Project Engineer', project: 'Water main trench rock, stage 1', locality: 'Huonville', region: 'Southern Tasmania', services: ['civil-construction'], value: 2215000, revs: [128], valid: 30, opens: [], expired: true, archived: { at: 120, reason: 'The client did not go ahead' } },
  { key: 'smithton', client: 'Circular Head Limestone Pty Ltd', contact: 'Hannah Price', position: 'Mine Manager', project: 'Misfire management support, north pit', locality: 'Smithton', region: 'North-West Tasmania', services: ['misfire-management'], value: 486000, revs: [112], valid: 14, opens: [[0, 112, 1]], accept: { rev: 0, at: 111, name: 'Hannah Price', position: 'Mine Manager' } },
  { key: 'sorell', client: 'Eaglehawk Constructions Pty Ltd', contact: 'Sam Ellery', position: 'Project Manager', project: 'Bridge abutment excavation', locality: 'Sorell', region: 'Southern Tasmania', services: ['civil-construction', 'microblasting'], value: 3360000, revs: [97], valid: 30, opens: [[0, 96, 1], [0, 90, 1]], docs: 1, expired: true, archived: { at: 40, reason: 'Awarded to another contractor' } },
  { key: 'longford', client: 'South Esk Quarry Co Pty Ltd', contact: 'Kate Brennan', position: 'Quarry Manager', project: 'Development blast for a new bench', locality: 'Longford', region: 'Northern Tasmania', services: ['quarry-mining'], value: 1745000, revs: [74], valid: 30, opens: [[0, 73, 1], [0, 71, 1], [0, 70, 3]], docs: 2, accept: { rev: 0, at: 69, name: 'Kate Brennan', position: 'Quarry Manager' } },
  { key: 'stanley', client: 'Stanley Point Construction Pty Ltd', contact: 'Rob Fenwick', position: 'Director', project: 'Car park extension, rock removal', locality: 'Stanley', region: 'North-West Tasmania', services: ['civil-construction'], value: 1428000, revs: [58, 12], revNote: 'Car park area extended after the site meeting.', valid: 30, opens: [[0, 57, 0], [1, 11, 0]], accept: { rev: 0, at: 52, name: 'Rob Fenwick', position: 'Director' } },
  { key: 'sheffield', client: 'Kentish Earthworks Pty Ltd', contact: 'Tegan Moss', position: 'Owner', project: 'Farm dam spillway rock', locality: 'Sheffield', region: 'North-West Tasmania', services: ['civil-construction'], value: 798000, revs: [34], valid: 30, opens: [[0, 33, 2], [0, 31, 2], [0, 29, 2]], docs: 1, opts: 1, accept: { rev: 0, at: 28, name: 'Tegan Moss', position: 'Owner' } },
  { key: 'bicheno', client: 'Granite Coast Builders Pty Ltd', contact: 'Luke Petrakis', position: 'Site Supervisor', project: 'House footings in granite, controlled rock removal', locality: 'Bicheno', region: 'East Coast Tasmania', services: ['microblasting'], value: 956000, revs: [26], valid: 30, opens: [[0, 25, 0], [0, 24, 4], [0, 21, 0]], docs: 1, opts: 1 },
  { key: 'newnorfolk', client: 'Macquarie Plains Quarry Pty Ltd', contact: 'Nina Holloway', position: 'Compliance Lead', project: 'Magazine management and reconciliation', locality: 'New Norfolk', region: 'Southern Tasmania', services: ['magazine-management'], value: 1260000, revs: [19], valid: 30, opens: [[0, 18, 1]], docs: 1, accept: { rev: 0, at: 15, name: 'Nina Holloway', position: 'Compliance Lead' } },
  { key: 'poatina', client: 'Western Tiers Civil Pty Ltd', contact: 'Grant Coles', position: 'Project Manager', project: 'Access road cutting, lower switchback', locality: 'Poatina', region: 'Northern Tasmania', services: ['civil-construction'], value: 4475000, revs: [12], valid: 30, opens: [[0, 11, 1], [0, 10, 1]], docs: 2, changes: { rev: 0, at: 1, name: 'Grant Coles', message: 'We need the programme to start a fortnight later, after the culvert pour. Can you also confirm standby rates if the weather holds us up?' } },
  { key: 'riverside4', client: 'Ashgrove Civil Pty Ltd', contact: 'Dana Whitfield', position: 'Project Manager', project: 'Ridgeway subdivision stage 4, trench rock', locality: 'Riverside', region: 'Northern Tasmania', services: ['civil-construction'], value: 2970000, revs: [9], valid: 30, opens: [], },
  { key: 'deloraine2', client: 'Blackwood Ridge Quarries Pty Ltd', contact: 'Mick Russo', position: 'Quarry Manager', project: 'Spring campaign, benches 5 and 6', locality: 'Deloraine', region: 'Northern Tasmania', services: ['quarry-mining', 'relief-shotfiring'], value: 7120000, revs: [27], valid: 30, opens: [[0, 26, 1], [0, 18, 1], [0, 6, 1]], docs: 2 },
  { key: 'wilmot', client: 'Lake Barrington Civil Pty Ltd', contact: 'Emma Lyons', position: 'Estimator', project: 'Boat ramp approach, rock trim', locality: 'Wilmot', region: 'North-West Tasmania', services: ['civil-construction'], value: 865000, revs: [25], valid: 28, opens: [[0, 23, 2]] },
  { key: 'kingston', client: 'Channel Homes Pty Ltd', contact: 'Ruby Tan', position: 'Building Supervisor', project: 'Retaining wall footings, rock removal', locality: 'Kingston', region: 'Southern Tasmania', services: ['microblasting'], status: 'draft', created: 2 },
  { key: 'bellbay2', client: 'Tamar Valley Earthworks Pty Ltd', contact: 'Lachlan Ward', position: 'Estimator', project: 'Industrial lot 14, bulk rock', locality: 'Bell Bay', region: 'Northern Tasmania', services: ['civil-construction'], status: 'draft', created: 5 },
  { key: 'practice', client: 'Example Client Pty Ltd', contact: 'Alex Example', position: 'Tester', project: 'Practice proposal for staff training', locality: 'Launceston', region: 'Northern Tasmania', services: ['civil-construction'], value: 100000, revs: [20], valid: 30, opens: [[0, 20, 1]], test: true },
];

export function seedDashboard(conn, { now = new Date() } = {}) {
  if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(String(conn))) throw new Error('seedDashboard only writes to a local database');
  const T = templateData();
  const names = new Map(T.services.map((s) => [s.slug, s.name]));
  const at = (daysAgo, hour = 10, minute = 0) => {
    const d = new Date(now.getTime() - daysAgo * DAY);
    d.setUTCHours(hour - 11 < 0 ? hour + 13 : hour - 11, minute, 0, 0); // roughly that hour in Hobart (AEDT)
    if (d > now) return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    return d.toISOString();
  };
  const ymd = (iso, plusDays = 0) => new Date(new Date(iso).getTime() + plusDays * DAY).toISOString().slice(0, 10);
  const sql = ['begin;', 'set local session_replication_role = replica;'];
  const ids = {};
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Hobart', year: 'numeric' }).format(now));
  // Numbered after anything the database has already issued, as the app would.
  const counters = new Map(psql(conn, "select key || '=' || value from public.texc_counters where key like 'reference:%'").split('\n').filter(Boolean)
    .map((l) => [Number(l.slice(10, 14)), Number(l.split('=')[1])]));
  // References in order of first issue, numbered per year as the app numbers them.
  const issuedOrder = PROPOSALS.filter((p) => p.revs).sort((a, b) => b.revs[0] - a.revs[0]);
  const refOf = new Map();
  for (const p of issuedOrder) {
    const y = Number(at(p.revs[0]).slice(0, 4));
    const n = (counters.get(y) || 0) + 1;
    counters.set(y, n);
    refOf.set(p.key, `${BRAND.refPrefix}-${y}-${String(n).padStart(3, '0')}`);
  }

  for (const p of PROPOSALS) {
    const id = randomUUID();
    ids[p.key] = id;
    const created = p.revs ? p.revs[0] + 1 : p.created;
    const events = [];
    const ev = (daysAgo, event, extra = {}, h = 10, m = 0) => events.push({ proposal_id: id, created_at: at(daysAgo, h, m), event, ...extra });
    ev(created, 'created', { actor: STAFF[0] }, 9, 12);
    const revIds = [];
    const revRows = [];
    (p.revs || []).forEach((daysAgo, i) => {
      const rid = randomUUID();
      revIds.push(rid);
      const label = String.fromCharCode(65 + i);
      const published = at(daysAgo, 14, 5 + i);
      const gst = Math.round(p.value / 10);
      revRows.push({
        id: rid, proposal_id: id, rev_index: i + 1, rev_label: label, enc: '{}', enc_sha256: hex(32), published_text: '{}', plaintext_sha256: hex(32),
        view_token_hash: hex(32), template_version: 1, quote_snapshot: { totals: { subtotal: p.value, gst, total: p.value + gst, unpriced: 0 } },
        attachments_snapshot: [], change_note: i ? (p.revNote || '') : '', published_at: published, published_by: STAFF[0],
        superseded_at: i < p.revs.length - 1 ? at(p.revs[i + 1], 14, 5 + i + 1) : null,
        withdrawn_at: p.status === 'withdrawn' && i === p.revs.length - 1 ? at(p.withdrawnAt, 9) : null,
      });
      ev(daysAgo, 'published', { revision_id: rid, actor: STAFF[0], meta: { rev: label } }, 14, 5 + i);
      if (i === 0) ev(daysAgo, 'link_emailed', { actor: STAFF[0], meta: { to: `${p.contact.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}@client.example` } }, 14, 7);
    });
    const views = [];
    (p.opens || []).forEach(([ri, daysAgo, dev], n) => {
      views.push({ proposal_id: id, revision_id: revIds[ri], session: `s${n}-${hex(4)}`, device: DEVICES[dev], region: 'TAS', created_at: at(daysAgo, 8 + (n % 6), 20 + n) });
    });
    const cur = revIds.length ? revIds.length - 1 : -1;
    const curViews = views.filter((v) => v.revision_id === revIds[cur]);
    const firstCur = curViews.length ? curViews[0] : null;
    // Documents opened and optional items ticked, a few minutes into the first visit to the current revision.
    const during = (n) => new Date(Date.parse(firstCur.created_at) + n * 150000).toISOString();
    for (let i = 0; i < (p.docs || 0) && firstCur; i += 1) {
      events.push({ proposal_id: id, created_at: during(i + 1), event: 'attachment_opened', revision_id: revIds[cur], session: firstCur.session, meta: { card: `doc-${i + 1}`, title: ['Preliminary risk assessment', 'Site plan', 'Public liability certificate'][i] } });
    }
    for (let i = 0; i < (p.opts || 0) && firstCur; i += 1) {
      events.push({ proposal_id: id, created_at: during(5 + i), event: 'option_toggled', revision_id: revIds[cur], session: firstCur.session, meta: { option: `opt-${i + 1}`, on: true } });
    }
    if (p.changes) ev(p.changes.at, 'changes_requested', { revision_id: revIds[p.changes.rev], session: views[0] && views[0].session, meta: { name: p.changes.name, email: 'contact@client.example', message: p.changes.message, rev: String.fromCharCode(65 + p.changes.rev) } }, 15, 40);
    let acc = null;
    if (p.accept) {
      const gst = Math.round(p.value / 10);
      acc = {
        id: randomUUID(), proposal_id: id, revision_id: revIds[p.accept.rev], kind: 'client', accepted_at: at(p.accept.at, 16, 10),
        name: p.accept.name, position: p.accept.position, company: p.client, email: 'contact@client.example', authority_confirmed: true, terms_confirmed: true,
        terms_version: null, clauses: {}, signature_kind: 'typed', typed_signature: p.accept.name, options: [], accepted_total_cents: p.value + gst,
        totals: { subtotal: p.value, gst, total: p.value + gst, unpriced: 0 }, plaintext_sha256: hex(32), ua_family: DEVICES[1], record_path: 'seed/record.html', record_sha256: hex(32),
      };
      ev(p.accept.at, 'accepted', { revision_id: acc.revision_id, meta: { acceptance: acc.id, rev: String.fromCharCode(65 + p.accept.rev), total_cents: acc.accepted_total_cents } }, 16, 10);
    }
    if (p.status === 'withdrawn') ev(p.withdrawnAt, 'withdrawn', { revision_id: revIds[cur], actor: STAFF[0], meta: { note: p.withdrawNote } }, 9);
    if (p.archived) ev(p.archived.at, 'archived', { actor: STAFF[1], meta: { reason: p.archived.reason } }, 11);

    const lastRev = p.revs ? at(p.revs[p.revs.length - 1], 14, 5) : null;
    const validUntil = lastRev ? ymd(lastRev, p.valid) : null;
    const allTimes = [...events.map((e) => e.created_at), ...views.map((v) => v.created_at)].sort();
    const status = p.status || (p.revs ? 'issued' : 'draft');
    const linkExpires = validUntil ? (p.expired ? new Date(Date.parse(`${validUntil}T13:59:59Z`)).toISOString() : new Date(Date.parse(`${validUntil}T13:59:59Z`) + 30 * DAY).toISOString()) : null;
    const searchExtra = [DOC_TYPES.shotfiring, ...p.services.map((s) => names.get(s) || s), p.contact].join(' ');
    sql.push(insert('texc_proposals', {
      id, slug: slug(), reference: refOf.get(p.key) || null, project: p.project, site_locality: p.locality, site_region: p.region, client_company: p.client,
      services: new TextArray(p.services), doc_type: 'shotfiring', status, access_token: p.revs ? hex(32) : null, passphrase_enc: p.revs ? 'seed' : null,
      issued_at: p.revs ? at(p.revs[0], 14, 5) : null, link_expires_at: linkExpires,
      valid_until: validUntil, value_cents: p.revs ? p.value : null,
      first_opened_at: views.length ? views[0].created_at : null, last_opened_at: views.length ? views[views.length - 1].created_at : null, open_count: views.length,
      is_test: !!p.test, created_at: at(created, 9, 12), created_by: STAFF[0], updated_at: allTimes[allTimes.length - 1],
      search_extra: searchExtra,
    }));
    for (const r of revRows) sql.push(insert('texc_proposal_revisions', r));
    if (revIds.length) sql.push(`update public.texc_proposals set current_revision_id = ${lit(revIds[cur])} where id = ${lit(id)};`);
    sql.push(insert('texc_drafts', { proposal_id: id, config: { meta: { project: p.project, siteLocality: p.locality, siteRegion: p.region, docType: 'shotfiring', status: 'preliminary', ...(validUntil ? { validUntil } : {}) }, client: { company: p.client, contactName: p.contact, contactPosition: p.position } }, version: 1, base_revision_id: revIds[cur] || null, updated_at: at(created, 9, 30), updated_by: STAFF[0] }));
    if (acc) {
      sql.push(insert('texc_acceptances', acc));
      sql.push(`update public.texc_proposals set accepted_at = ${lit(acc.accepted_at)}, accepted_revision_id = ${lit(acc.revision_id)} where id = ${lit(id)};`);
    }
    if (p.archived) sql.push(`update public.texc_proposals set archived_at = ${lit(at(p.archived.at, 11))}, archived_by = ${lit(STAFF[1])}, archive_reason = ${lit(p.archived.reason)} where id = ${lit(id)};`);
    for (const v of views) sql.push(insert('texc_proposal_views', v));
    for (const e of events.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      sql.push(insert('texc_events', { revision_id: null, session: null, actor: null, meta: {}, ...e }));
    }
  }
  for (const [y, n] of counters) sql.push(`insert into public.texc_counters (key, value) values ('reference:${y}', ${n}) on conflict (key) do update set value = excluded.value;`);
  sql.push('commit;');
  psql(conn, sql.join('\n'));
  if (!counters.has(year)) psql(conn, `insert into public.texc_counters (key, value) values ('reference:${year}', 0) on conflict do nothing`);
  return { ids, count: PROPOSALS.length };
}
