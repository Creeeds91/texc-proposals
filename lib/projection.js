/**
 * toPublished(): what a client receives, built from a draft by ALLOWLIST.
 *
 * The server serialises this once, hashes those exact bytes and encrypts them
 * (lib/envelope.js), so it is the single source of truth for what a client saw:
 *
 *   - only the sections that are switched on carry content; a hidden section
 *     is listed as off and carries nothing
 *   - editor bookkeeping never leaves: acknowledgements, presets used, the
 *     client's email, "rate unconfirmed" notes, who unlocked a safety line
 *   - competencies not marked confirmed are dropped, not just hidden
 *   - website wording, locked lines, the suite register, the services, people
 *     and photographs it uses are FROZEN into the revision (`tpl`), so a later
 *     website or library edit can never change an issued proposal
 *   - a $confirm anywhere refuses the whole publish (the checklist blocks it
 *     first; this is the second lock)
 */
import { SECTIONS, visibleSections, isConfirm } from '../assets/js/schema.js';
import { RELEASED_FILE, CARD_ID } from '../assets/js/checks.js';
import { quoteTotals } from '../assets/js/money.js';
import { SNAP_ROWS } from './template-data.js';

const PUBLISHABLE_STATUS = new Set(['preliminary', 'issued']);
const META_KEYS = ['docType', 'project', 'siteLocality', 'siteRegion', 'validUntil', 'preparedBy'];
const CLIENT_KEYS = ['company', 'contactName', 'contactPosition'];
// Editor-only fields, removed wherever they appear.
const STRIP = new Set(['unconfirmed', 'acks', 'presetsUsed', 'unlocks', '_about']);

export class Unpublishable extends Error {}

const clone = (v) => JSON.parse(JSON.stringify(v));
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, clone(obj[k])]));

function scrub(value, path = '') {
  if (isConfirm(value)) throw new Unpublishable(`Unconfirmed content at ${path || 'the top level'}`);
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRIP.has(k) || v === undefined) continue;
      out[k] = scrub(v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return value;
}

/** Every image reference id in a value: { id, alt? } objects under image-ish keys. */
function imageIds(value, key = '', out = new Set()) {
  if (Array.isArray(value)) { value.forEach((v) => imageIds(v, key, out)); return out; }
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && /image|photo|portrait|sitePlan/i.test(key)) out.add(value.id);
    for (const [k, v] of Object.entries(value)) imageIds(v, /image|photo|portrait|sitePlan/i.test(k) ? k : (/^\d+$/.test(k) ? key : k), out);
  }
  return out;
}

/**
 * draft  the stored draft config
 * ctx    { tpl: templateData(), reference, revLabel, issueDate, viewToken, templateVersion,
 *          files: { <attachment id>: texc_attachments row } }
 * Returns { config, quoteSnapshot, termsVersion, mediaIds, attachmentsSnapshot }.
 */
export function toPublished(draft, ctx) {
  const src = clone(draft || {});
  const visible = new Set(visibleSections(src));
  const out = {
    v: 1,
    template: ctx.templateVersion,
    layout: { sections: [...visibleSections(src), ...SECTIONS.map((s) => s.id).filter((id) => !visible.has(id))].map((id) => ({ id, on: visible.has(id) })) },
  };

  // Cover: a fixed set of fields, plus what the server decides.
  const status = PUBLISHABLE_STATUS.has(src.meta?.status) ? src.meta.status : 'issued';
  out.meta = { ...pick(src.meta, META_KEYS), reference: ctx.reference, rev: ctx.revLabel, issueDate: ctx.issueDate, status };
  out.client = pick(src.client, CLIENT_KEYS);
  if (src.cover) out.cover = pick(src.cover, ['image']);
  if (src.demo === true) out.demo = true;

  // Every other section: its own keys, only when it is on.
  for (const s of SECTIONS) {
    if (s.id === 'cover' || !visible.has(s.id)) continue;
    for (const key of s.keys) if (src[key] !== undefined) out[key] = clone(src[key]);
  }

  // Scope: who unlocked a safety line is staff business; that it was unlocked is all the page needs.
  if (out.scope && Array.isArray(out.scope.services)) {
    out.scope.services = out.scope.services.map((x) => {
      const keep = pick(x, ['slug', 'scopeText']);
      if (x.safetyUnlockedBy && typeof x.safety === 'string' && x.safety.trim()) { keep.safety = x.safety; keep.safetyUnlockedBy = true; }
      return keep;
    });
  }
  // Attachments: only what a client may see or ask for. A card the client can
  // open carries the facts of its file as the server measured them; which file
  // that is goes into the revision's snapshot, never to the client.
  const attachmentsSnapshot = [];
  if (Array.isArray(out.attachments)) {
    const files = ctx.files || {};
    out.attachments = out.attachments.filter((x) => x && (x.visibility === 'client' || x.visibility === 'on-request')).map((x) => {
      const keep = pick(x, ['id', 'title', 'category', 'docCode', 'docRev', 'docDate', 'visibility']);
      if (x.visibility !== 'client') return keep;
      const f = files[x.file];
      if (!f || !RELEASED_FILE.has(f.scan_status)) throw new Unpublishable(`The attachment “${x.title || x.id}” has no file that passed the check`);
      if (!CARD_ID.test(String(x.id || '')) || attachmentsSnapshot.some((s) => s.card === x.id)) throw new Unpublishable(`The attachment “${x.title || x.id}” has a damaged card`);
      keep.pages = Number.isInteger(f.pages) ? f.pages : undefined;
      keep.bytes = Number(f.bytes) || undefined;
      attachmentsSnapshot.push({
        card: x.id, file: f.id, path: f.storage_path, sha256: f.sha256, bytes: Number(f.bytes) || 0, pages: f.pages ?? null,
        title: String(x.title || ''), name: downloadName(ctx.reference, x.title), released: f.scan_status,
      });
      return keep;
    });
  }
  // Team: an unconfirmed competency never leaves the building.
  if (out.team && Array.isArray(out.team.people)) {
    out.team.people = out.team.people.map((p) => ({ ...p, competencies: (p.competencies || []).filter((c) => c && c.confirmed === true) }));
  }
  // About: freeze the website's capability strip and steps into the revision.
  if (visible.has('about')) {
    out.about = { ...(out.about || {}) };
    if (out.about.strip === undefined) out.about.strip = clone(SNAP_ROWS.strip);
    if (out.about.steps === undefined) out.about.steps = clone(SNAP_ROWS.steps);
  }

  const config = scrub(out);

  // Freeze the template data this revision uses.
  const T = ctx.tpl;
  const usedSlugs = new Set([
    ...(config.scope?.services || []).map((x) => x.slug),
    ...(config.logistics?.commitments || []).map((k) => String(k).split('.')[0]),
  ]);
  const usedPeople = new Set((config.team?.people || []).map((p) => p.personId).filter(Boolean));
  const usedDocs = new Set((config.docs?.items || []).map((d) => d.id));
  const ids = imageIds(config);
  if (T.principalPhoto) ids.add(T.principalPhoto);
  for (const p of T.people || []) if (usedPeople.has(p.slug) && T.photos[p.slug]) ids.add(p.slug);
  config.tpl = {
    locked: T.locked,
    snap: T.snap,
    services: (T.services || []).filter((x) => usedSlugs.has(x.slug)),
    serviceIcons: Object.fromEntries(Object.entries(T.serviceIcons || {}).filter(([k]) => usedSlugs.has(k))),
    // Only what the page shows of a person: never the website's unconfirmed competency or licence lists.
    people: (T.people || []).filter((p) => usedPeople.has(p.slug)).map((p) => ({ slug: p.slug, name: p.name, role: p.role, bio: p.bio, licenceNote: p.licenceNote })),
    register: (T.register || []).filter((r) => usedDocs.has(r.id)),
    workflow: config.docs?.workflow?.on === true ? T.workflow : undefined,
    photos: Object.fromEntries(Object.entries(T.photos || {}).filter(([k]) => ids.has(k))),
    principalPhoto: T.principalPhoto,
    ratingsEnabled: T.ratingsEnabled === true,
  };
  if (config.tpl.workflow === undefined) delete config.tpl.workflow;

  // Uploaded photographs: the page asks for signed links to these after unlocking.
  const mediaIds = [...ids].filter((id) => /^u-[a-f0-9]{16}$/.test(id) && src.media && src.media[id]);
  if (mediaIds.length) config.media = Object.fromEntries(mediaIds.map((id) => [id, pick(src.media[id], ['widths', 'type'])]));

  config.__vt = ctx.viewToken;

  // What acceptance (Phase 5) will be checked against: the lines and terms as published.
  const lines = (config.quote?.lines || []).map((l) => pick(l, ['id', 'desc', 'basis', 'qtyHundredths', 'unit', 'rateCents', 'optional', 'optionalDefault']));
  const defaults = lines.filter((l) => l.optional && l.optionalDefault).map((l) => l.id);
  const totals = visible.has('quote') ? quoteTotals(lines, defaults) : null;
  const quoteSnapshot = { lines, terms: config.quote?.terms || {}, defaultOptions: defaults, totals };

  return { config, quoteSnapshot, termsVersion: typeof config.terms?.version === 'string' ? config.terms.version : null, mediaIds, attachmentsSnapshot };
}

/** What a client's downloaded copy is called: "TEXC-P-2026-001 Civil Shotfiring Risk & Compliance Tool.pdf". */
export function downloadName(reference, title) {
  const clean = (v) => String(v || '').replace(/[^A-Za-z0-9 ._()&'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${[clean(reference), clean(title).slice(0, 100)].filter(Boolean).join(' ') || 'document'}.pdf`;
}

/** The final guard on the bytes themselves. */
export function assertClean(text) {
  if (text.includes('"$confirm"') || /CONFIRM/.test(text)) throw new Unpublishable('The published text still contains CONFIRM');
}

/** Today in Hobart, YYYY-MM-DD. */
export function hobartToday(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Hobart', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** A, B, … Z, AA, AB … */
export function revLabel(index) {
  let n = index;
  let s = '';
  while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
