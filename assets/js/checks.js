/**
 * The pre-publish checklist. Pure: a config in, a list of findings out — so the
 * editor shows exactly what the server (Phase 3) will refuse.
 *
 *   runChecks(cfg, ctx) -> { blockers, warnings, acks, ready }
 *
 *   blockers  must be fixed before publishing
 *   acks      must each be acknowledged (cfg.acks holds the keys); until then
 *             they block too. Sensitive-looking text, Chalmers-derived wording
 *             used on another site, rates from the superseded prototype.
 *   warnings  worth knowing, never blocking
 *
 * ctx: { today: 'YYYY-MM-DD', services: [{slug, pending}], register: [{id, status}], brand: 'name' }
 */
import { SECTIONS, SECTION_OF_KEY, visibleSections, isConfirm } from './schema.js';
import { scanText, localityWarning } from './sensitive.js';
import { lineAmountCents } from './money.js';

const LABEL = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]));
const SKIP_KEYS = new Set(['layout', 'media', 'acks', 'presetsUsed', 'v', 'template', 'demo', 'documentTitle', 'unlocks', '_about']);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// What a row is called in a checklist message, by list path.
const ROW_NAME = {
  'risk.hazards': 'Hazard', 'risk.holdPoints': 'Hold point', 'risk.intro': 'Risk introduction paragraph', 'method.steps': 'Method step',
  'method.callouts': 'Method callout', 'scope.matrix': 'Responsibility row', 'site.meta': 'Site detail', 'site.constraints': 'Constraint',
  'env.locations': 'Monitoring location', 'env.limits.rows': 'Limit', 'env.controls': 'Control', 'docs.projectDocs': 'Project document',
  'team.people': 'Team member', 'programme.phases': 'Programme phase', 'quote.lines': 'Quotation line', 'attachments': 'Attachment',
  'understanding.photos': 'Photograph', 'site.photos': 'Site photograph',
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const present = (v) => (Array.isArray(v) ? v.some((x) => (typeof x === 'string' ? x.trim() : x)) : str(v) !== '');

/** A short stable hash, so an acknowledgement stays attached to the exact text it was given for. */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Every leaf of a config with its path, skipping bookkeeping keys. */
function* leaves(value, path = []) {
  if (isConfirm(value)) { yield [path, value]; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) yield* leaves(value[i], [...path, i]); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (path.length === 0 && SKIP_KEYS.has(k)) continue;
      yield* leaves(v, [...path, k]);
    }
    return;
  }
  yield [path, value];
}

const pathText = (p) => p.map((x) => (typeof x === 'number' ? `[${x + 1}]` : x)).join('.').replace(/\.\[/g, '[');

export function runChecks(cfg = {}, ctx = {}) {
  const blockers = [];
  const warnings = [];
  const acks = [];
  const B = ctx.brand || 'the business';
  const visible = new Set(visibleSections(cfg));
  const sectionOf = (path) => SECTION_OF_KEY[path[0]];
  const isVisible = (path) => { const s = sectionOf(path); return s && visible.has(s); };
  const block = (section, message, field) => blockers.push({ section, label: LABEL[section], message, field });
  const warn = (section, message) => warnings.push({ section, label: LABEL[section], message });
  const acked = new Set(Array.isArray(cfg.acks) ? cfg.acks : []);
  const needAck = (key, section, message, detail) => acks.push({ key, section, label: LABEL[section], message, detail, done: acked.has(key) });

  // 1. Nothing unconfirmed in a visible section.
  for (const [path, value] of leaves(cfg)) {
    if (isConfirm(value) && isVisible(path)) {
      block(sectionOf(path), `Unconfirmed: ${str(value.$confirm) || 'needs confirming'}`, pathText(path));
    }
  }

  // 2. Required fields.
  const meta = cfg.meta || {};
  const client = cfg.client || {};
  if (!str(meta.project)) block('cover', 'Project name is required', 'meta.project');
  if (!str(meta.siteLocality)) block('cover', 'Site locality (suburb) is required', 'meta.siteLocality');
  if (!str(client.company)) block('cover', 'Client company is required', 'client.company');
  if (!str(client.contactName)) block('cover', 'Client contact is required', 'client.contactName');
  if (!EMAIL.test(str(client.email))) block('cover', 'A valid client email is required (it is never shown on the page)', 'client.email');
  if (!DATE.test(str(meta.validUntil))) block('cover', 'Valid-until date is required', 'meta.validUntil');
  else if (ctx.today && meta.validUntil < ctx.today) block('cover', 'Valid-until date is in the past', 'meta.validUntil');
  if (!cfg.cover?.image?.id) block('cover', 'A cover photograph is required', 'cover.image');
  if (visible.has('letter') && !present(cfg.letter?.body)) block('letter', 'The covering letter has no text', 'letter.body');
  if (visible.has('understanding') && !present(cfg.understanding?.paras)) block('understanding', 'Project understanding has no text', 'understanding.paras');
  if (visible.has('scope') && !(cfg.scope?.services || []).length) block('scope', 'Choose at least one service', 'scope.services');
  if (visible.has('risk') && !(cfg.risk?.holdPoints || []).length) block('risk', 'Hold points are required (HP1 is what acceptance means)', 'risk.holdPoints');

  // 3. Compliance structure.
  if (!visible.has('terms')) block('terms', 'Terms and disclaimers must stay on — it carries the preliminary status, misfire and emergency lines', 'layout');
  const pending = new Set((ctx.services || []).filter((s) => s.pending).map((s) => s.slug));
  for (const s of cfg.scope?.services || []) if (pending.has(s.slug)) block('scope', `"${s.slug}" is not a service offered yet and cannot be proposed`, 'scope.services');
  const drafts = new Set((ctx.register || []).filter((d) => d.status !== 'approved').map((d) => d.id));
  for (const d of cfg.docs?.items || []) if (drafts.has(d.id) && d.provide !== false) block('docs', `${d.id} is a draft awaiting ${B} approval and cannot be offered`, 'docs.items');

  // 4. Images need alt text.
  const imageRefs = [];
  const findImages = (v, path) => {
    if (!v || typeof v !== 'object' || isConfirm(v)) return;
    if (typeof v.id === 'string' && ('alt' in v || 'crop' in v || path.some((seg) => /photo|portrait|image|sitePlan/i.test(String(seg))))) imageRefs.push([path, v]);
    for (const [k, x] of Object.entries(v)) findImages(x, [...path, k]);
  };
  for (const key of Object.keys(cfg)) if (!SKIP_KEYS.has(key)) findImages(cfg[key], [key]);
  for (const [path, ref] of imageRefs) if (isVisible(path) && !str(ref.alt)) block(sectionOf(path), 'An image has no alt text', pathText(path));

  // 4b. No blank rows: an added-but-empty row prints as an empty card or cell.
  const blank = (v) => (isConfirm(v) ? false : Array.isArray(v) ? v.every(blank) : v && typeof v === 'object' ? Object.values(v).every(blank) : !(typeof v === 'number' || typeof v === 'boolean' || str(v)));
  const walkRows = (v, path) => {
    if (!v || typeof v !== 'object' || isConfirm(v)) return;
    if (Array.isArray(v)) {
      v.forEach((row, i) => { if (row && typeof row === 'object' && !isConfirm(row) && blank(row)) block(sectionOf(path), `${ROW_NAME[path.join('.')] || pathText(path)} ${i + 1} is empty — fill it in or delete it`, pathText([...path, i])); });
    }
    for (const [k, x] of Object.entries(v)) walkRows(x, [...path, Array.isArray(v) ? Number(k) : k]);
  };
  for (const key of Object.keys(cfg)) if (!SKIP_KEYS.has(key) && isVisible([key])) walkRows(cfg[key], [key]);
  for (const key of ['understanding', 'site']) {
    if (!visible.has(key)) continue;
    (cfg[key]?.photos || []).forEach((p, i) => { if (p && !blank(p) && !p.image?.id) block(key, `Photograph ${i + 1} has no image chosen`, `${key}.photos[${i + 1}]`); });
  }
  if (visible.has('risk')) {
    (cfg.risk?.hazards || []).forEach((r, i) => { if (r && !blank(r) && (!present(r.hazard) || !present(r.control))) block('risk', `Hazard ${i + 1} needs both the hazard and its control`, `risk.hazards[${i + 1}]`); });
  }
  if (visible.has('env')) {
    (cfg.env?.limits?.rows || []).forEach((r, i) => { if (r && !blank(r) && !present(r.source) && !isConfirm(r.source)) block('env', `Limit ${i + 1} needs its source (the site approval or regulator)`, `env.limits.rows[${i + 1}]`); });
  }

  // 5. The quotation reconciles.
  if (visible.has('quote')) {
    const lines = Array.isArray(cfg.quote?.lines) ? cfg.quote.lines : [];
    if (!lines.length) block('quote', 'The quotation has no lines', 'quote.lines');
    let priced = 0;
    lines.forEach((line, i) => {
      if (!str(line.desc)) block('quote', `Line ${i + 1} has no description`, `quote.lines[${i + 1}]`);
      try { if (lineAmountCents(line) != null) priced += 1; }
      catch { block('quote', `Line ${i + 1} has an invalid quantity or rate`, `quote.lines[${i + 1}]`); }
      if (line.rateCents == null && line.basis !== 'at-cost') block('quote', `Line ${i + 1} has no rate`, `quote.lines[${i + 1}]`);
      if (str(line.unconfirmed)) needAck(`rate:${line.id}:${hashText(String(line.rateCents))}`, 'quote', `Line ${i + 1}: ${line.unconfirmed}`, str(line.desc));
    });
    if (lines.length && !priced) block('quote', 'No line in the quotation has a price', 'quote.lines');
  }

  // 6. Acknowledgements: likely-sensitive text, and unapproved preset wording.
  for (const [path, value] of leaves(cfg)) {
    if (typeof value !== 'string' || !isVisible(path)) continue;
    for (const hit of scanText(value)) {
      needAck(`sensitive:${pathText(path)}:${hashText(hit.match)}`, sectionOf(path), `${hit.label}?`, `“${hit.match}” in ${pathText(path)}`);
    }
  }
  const loc = localityWarning(meta.siteLocality);
  if (loc) needAck(`sensitive:meta.siteLocality:${hashText(loc.match)}`, 'cover', `${loc.label}?`, `“${loc.match}” — the cover shows suburb and region only`);
  for (const used of Array.isArray(cfg.presetsUsed) ? cfg.presetsUsed : []) {
    if (!str(used.confirm)) continue;
    const section = SECTION_OF_KEY[String(used.path || '').split('.')[0]] || 'cover';
    if (!visible.has(section)) continue;
    needAck(`preset:${used.id}:${used.path}`, section, used.confirm, used.name);
  }

  // 7. Worth knowing.
  if (visible.has('params')) warn('params', 'Blast parameters are on. Only George decides whether quantities appear on a link-shared page (Q9).');
  if (visible.has('docs') && cfg.docs?.workflow?.on === true) warn('docs', `The workflow diagram is on, but ${B} has not approved that document yet (C21).`);
  if (visible.has('logistics')) warn('logistics', `The logistics lines still need ${B} sign-off as proposal wording (C20).`);
  if (!present(cfg.terms?.body)) warn('terms', 'No terms and conditions are attached; the acceptance wording leaves them out (Q7).');
  if (visible.has('attachments') && (cfg.attachments || []).some((a) => a.visibility === 'client' && !a.file)) warn('attachments', 'Attachment files are added in Phase 4; these cards have no file yet.');
  if (cfg.demo === true) warn('cover', 'This is the demo proposal (fictional client and site).');

  const ready = blockers.length === 0 && acks.every((a) => a.done);
  return { blockers, warnings, acks, ready };
}
