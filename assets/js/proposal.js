/**
 * Client proposal runtime — the page a client reads, and (Phase 2) the live
 * preview inside the editor. Three exports carry the contract, as in the
 * Roberts IAP this is modelled on:
 *
 *   applyConfig(cfg)        bind a proposal config to the page. Idempotent and
 *                           cheap: the editor calls it on every keystroke. A key
 *                           ABSENT from cfg restores the template's built-in
 *                           default — never the previous proposal's value.
 *   initEffects(root)       reveals, progress bar, section index, print. Once.
 *   whenImagesReady(root)   resolves when the page's images have loaded or the
 *                           cap passes, so a reveal never shows a blank frame.
 *
 * Unconfirmed content is stored as {"$confirm": "what is needed"}. It is never
 * a string, so nothing below can print it: on a client page it renders as
 * nothing; in editor mode it renders as a red CONFIRM tag. See
 * docs/architecture.md, "CONFIRM can never reach a client".
 *
 * No business names live here — they come from the brand data block that
 * scripts/build.mjs writes into the page (lib/brand.js is the source).
 */
import { BASES, quoteTotals, lineAmountCents, formatAUD, formatQty } from './money.js';
import { PINNED_FIRST, PINNED_LAST, DEFAULT_OFF, DOC_TYPES, STATUS, isConfirm } from './schema.js';
import { acceptClause, signatureMode, sameName, EMAIL_RE, LIMITS } from './acceptance.js';

const D = document;
const ROOT = D.documentElement;

function readJson(id) {
  const el = D.getElementById(id);
  if (!el) return {};
  try { return JSON.parse(el.textContent); } catch { return {}; }
}
const BRAND = readJson('brand-data');
const PAGE_TPL = readJson('template-data');
// A published revision carries the website wording, services, people and
// register it was issued with (config.tpl, written by lib/projection.js); those
// win over the page's own copy, so a later website edit never changes an
// issued proposal. The editor and the demo use the page's copy.
let TPL = PAGE_TPL;

/* ------------------------------------------------------------------ helpers */

const editorMode = () => ROOT.dataset.mode === 'editor';
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null && !isConfirm(x)) : []);

function present(v) {
  if (v == null || v === false || isConfirm(v)) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return list(v).some(present);
  if (typeof v === 'object') return Object.values(v).some(present);
  return true;
}

function fillTokens(text) {
  return String(text).replace(/\{(\w+)\}/g, (m, key) => (typeof BRAND[key] === 'string' ? BRAND[key] : m));
}

function confirmTag(v) {
  const mark = D.createElement('mark');
  mark.className = 'confirm';
  mark.textContent = 'CONFIRM — ' + str(v.$confirm);
  return mark;
}

/** Editor mode only: the tag, then the wording waiting on confirmation (if any), so the layout reads true. */
function confirmWithSuggestion(v) {
  const out = [confirmTag(v)];
  const text = Array.isArray(v.suggested) ? v.suggested.filter((x) => typeof x === 'string').join(' ') : str(v.suggested);
  if (text) {
    const span = D.createElement('span');
    span.className = 'confirm-suggested';
    span.textContent = ' ' + text;
    out.push(span);
  }
  return out;
}

/** Text into an element. A $confirm shows only in editor mode; otherwise the fallback. */
function setText(el, value, fallback = '') {
  if (isConfirm(value)) {
    if (editorMode()) { el.replaceChildren(...confirmWithSuggestion(value)); return; }
    value = undefined;
  }
  const text = str(value);
  el.textContent = text !== '' ? text : fallback;
}

/** **bold** is the only markup a proposal can carry. Built from text nodes, never innerHTML. */
function setRich(el, text) {
  el.replaceChildren();
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const b = D.createElement('strong'); b.textContent = part; el.append(b); }
    else el.append(D.createTextNode(part));
  });
}

function setParas(el, value) {
  el.replaceChildren();
  if (isConfirm(value) && editorMode()) { const p = D.createElement('p'); p.append(...confirmWithSuggestion(value)); el.append(p); return; }
  const paras = typeof value === 'string' ? value.split(/\n\s*\n/) : list(value);
  for (const text of paras) {
    if (isConfirm(text) || !str(text).trim()) continue;
    const p = D.createElement('p');
    setRich(p, text);
    el.append(p);
  }
}

const dateFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
const fmtDate = (iso) => { const d = parseDate(iso); return d ? dateFmt.format(d) : ''; };
const fmtShort = (iso) => { const d = parseDate(iso); return d ? shortFmt.format(d) : ''; };

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
}

/* --------------------------------------------------------------- vocabulary */

const HOLD_STATUS = { open: 'Open', met: 'Met', na: 'Not applicable' };
const PARTIES = { texc: 1, client: 1, shared: 1 };
const PARAMS = [
  ['holesPerShot', 'Holes per shot'],
  ['shots', 'Number of shots / areas'],
  ['holeDiameter', 'Hole diameter'],
  ['depthRange', 'Depth range'],
  ['burdenSpacing', 'Burden and spacing'],
  ['stemming', 'Stemming'],
  ['initiation', 'Initiation system'],
  ['mic', 'Maximum instantaneous charge'],
  ['powderFactor', 'Powder factor'],
  ['containment', 'Matting and containment'],
];
const TERMS = [
  ['minimum', 'Minimum engagement'],
  ['standby', 'Standby'],
  ['travel', 'Travel'],
  ['mobilisation', 'Mobilisation and accommodation'],
  ['invoicing', 'Invoicing'],
  ['payment', 'Payment terms'],
];
const ATTACH_GROUPS = [
  ['project', 'Project documents'],
  ['risk', 'Risk and compliance'],
  ['drawings', 'Drawings and plans'],
  ['certificates', 'Certificates and insurance'],
  ['other', 'Other'],
];

/* ------------------------------------------------------------------ images */

function mediaFor(id, cfg) {
  if (!id) return null;
  const m = (cfg.media && cfg.media[id]) || (TPL.photos && TPL.photos[id]);
  if (!m) return null;
  if (Array.isArray(m.srcset)) return { srcset: m.srcset, src: m.src || m.srcset[m.srcset.length - 1][1] };
  if (Array.isArray(m.widths) && m.path) {
    const srcset = m.widths.map((w) => [w, m.path.replace('{w}', w)]);
    const mid = srcset.find(([w]) => w >= 1200) || srcset[srcset.length - 1];
    return { srcset, src: mid[1] };
  }
  return m.src ? { src: m.src, srcset: [] } : null;
}

function setImage(img, ref, cfg) {
  const media = ref && !isConfirm(ref) ? mediaFor(ref.id, cfg) : null;
  if (!media) {
    if (img.__def) { img.src = img.__def; img.removeAttribute('srcset'); }
    else { img.removeAttribute('src'); img.removeAttribute('srcset'); }
    img.alt = '';
    img.style.transform = '';
    return false;
  }
  if (media.srcset.length) img.srcset = media.srcset.map(([w, u]) => `${u} ${w}w`).join(', ');
  else img.removeAttribute('srcset');
  if (img.getAttribute('src') !== media.src) img.src = media.src;
  img.alt = str(ref.alt);
  const c = ref.crop;
  img.style.transform = c && (c.x || c.y || (c.s && c.s !== 1))
    ? `translate(${+c.x || 0}%, ${+c.y || 0}%) scale(${+c.s || 1})`
    : '';
  if (ref.position) img.style.objectPosition = str(ref.position);
  return true;
}

/* ------------------------------------------------------------- defaults */

let captured = false;
function captureDefaults() {
  if (captured) return;
  captured = true;
  D.querySelectorAll('[data-field]').forEach((el) => {
    el.__def = el.hasAttribute('data-empty') ? el.getAttribute('data-empty') : el.textContent;
  });
  D.querySelectorAll('[data-img]').forEach((img) => { img.__def = img.getAttribute('src') || ''; });
  D.querySelectorAll('[data-rows]').forEach((box) => {
    box.__defHTML = box.innerHTML;
    const row = box.querySelector('[data-row]');
    box.__tpl = row ? row.cloneNode(true) : null;
  });
  D.querySelectorAll('[data-list], [data-col-list]').forEach((ul) => {
    const li = ul.firstElementChild;
    ul.__tpl = li ? li.cloneNode(true) : D.createElement('li');
  });
}

/* ------------------------------------------------------------ derived view */

const state = { cfg: {}, view: {}, options: new Set(), effects: null };

function snapService(slug) {
  return (TPL.services || []).find((s) => s.slug === slug) || null;
}

function deriveView(cfg) {
  const v = JSON.parse(JSON.stringify(cfg || {}));
  const meta = (v.meta = v.meta || {});
  const client = (v.client = v.client || {});

  meta.docTypeLabel = DOC_TYPES[str(meta.docType)] || '';
  meta.statusLabel = STATUS[str(meta.status)] || '';
  meta.siteLine = [str(meta.siteLocality), str(meta.siteRegion)].filter(Boolean).join(' · ');
  meta.revLabel = str(meta.rev) ? 'Rev ' + str(meta.rev) : '';
  meta.issueDateText = fmtDate(meta.issueDate);
  meta.validUntilText = fmtDate(meta.validUntil);
  meta.footerLine = [
    str(meta.reference),
    str(meta.rev) ? 'REV ' + str(meta.rev) : '',
    str(BRAND.legalName).toUpperCase(),
    BRAND.abn ? 'ABN ' + BRAND.abn : '',
  ].filter(Boolean).join(' · ');
  client.contactLine = [str(client.contactName), str(client.contactPosition)].filter(Boolean).join(', ');
  if (!str(v.documentTitle)) {
    v.documentTitle = ['Private proposal', str(meta.reference)].filter(Boolean).join(' · ') + (BRAND.name ? ' · ' + BRAND.name : '');
  }

  // Scope: a service is chosen by slug; its name, category and safety line come
  // from the website snapshot. The safety line is locked — a proposal's own
  // wording replaces it only where an admin unlocked it (recorded by name).
  // Pending services make no capability claim and are never shown.
  const scope = (v.scope = v.scope || {});
  scope.services = list(scope.services).map((item) => {
    const s = snapService(item.slug);
    if (!s || s.pending) return null;
    return {
      name: s.name,
      category: s.category !== s.name ? s.category : '',
      icon: (TPL.serviceIcons || {})[s.slug] || 'hard-hat',
      scopeText: present(item.scopeText) ? item.scopeText : s.overview,
      safety: item.safetyUnlockedBy && present(item.safety) ? item.safety : s.safety,
    };
  }).filter(Boolean);
  scope.matrix = list(scope.matrix).map((r) => ({ ...r, note: str(r.note) || (r.party === 'to-be-agreed' ? 'To be agreed' : '') }));

  // At a glance.
  const g = (v.glance = v.glance || {});
  const prog = (v.programme = v.programme || {});
  prog.startText = fmtDate(prog.start);
  prog.finishText = fmtDate(prog.finish);
  g.services = scope.services.map((s) => s.name).join(', ');
  g.start = str(g.startText) || prog.startText;
  g.duration = str(g.durationText) || str(prog.duration);
  g.leadTime = str(g.leadTimeText) || str(prog.leadTime);

  const risk = (v.risk = v.risk || {});
  risk.holdPoints = list(risk.holdPoints).map((h) => ({ ...h, statusLabel: HOLD_STATUS[h.status] || HOLD_STATUS.open }));
  const holds = risk.holdPoints;
  const open = holds.filter((h) => h.status !== 'met' && h.status !== 'na').length;
  g.holds = holds.length ? (open ? `${open} of ${holds.length} open` : 'None') : '';

  // Documentation: ids join the suite register. A draft (TEXC12) is never offered.
  const docs = (v.docs = v.docs || {});
  const reg = new Map((TPL.register || []).map((d) => [d.id, d]));
  docs.items = list(docs.items).filter((d) => d.provide !== false).map((d) => {
    const r = reg.get(d.id);
    if (!r || r.status !== 'approved') return null;
    return { id: r.id.replace(/^([A-Z]+)(\d+)$/, '$1-$2'), code: r.code, title: r.title, category: r.category, note: str(d.note) };
  }).filter(Boolean);
  docs.workflow = { on: Boolean(docs.workflow && docs.workflow.on === true) };

  // Logistics: generic commitments chosen from fixed wording only. No free text.
  const lg = (v.logistics = v.logistics || {});
  lg.lines = list(lg.commitments).map((key) => {
    const [slug, field] = str(key).split('.');
    const s = snapService(slug);
    return s && (field === 'safety' || field === 'integrate' || field === 'value') ? s[field] || s.safety : '';
  }).filter(Boolean);

  // Team: people come from the website's profiles. Only competencies marked
  // confirmed are shown — the website lists them as CONFIRM until sighted.
  const team = (v.team = v.team || {});
  team.people = list(team.people).map((p) => {
    const s = (TPL.people || []).find((x) => x.slug === p.personId) || {};
    const name = str(p.name) || str(s.name);
    return {
      name,
      role: str(p.role) || str(s.role),
      bio: present(p.bio) ? p.bio : s.bio || [],
      photo: p.photo || (s.slug && TPL.photos && TPL.photos[s.slug] ? { id: s.slug, alt: `Portrait of ${name}` } : null),
      monogram: name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase(),
      competencies: list(p.competencies).filter((c) => c && c.confirmed === true).map((c) => str(c.text)),
      evidence: str(p.evidence) || str(s.licenceNote),
    };
  });

  const env = (v.env = v.env || {});
  env.limits = env.limits || {};
  env.limits.pending = present(env.limits.rows) ? '' : (str(client.company)
    ? `Limits will be added here from the site approval supplied by ${str(client.company)}.`
    : 'Limits will be added here from the site approval supplied by the client.');

  const contact = (v.contact = v.contact || {});
  if (!contact.photo && TPL.principalPhoto) contact.photo = { id: TPL.principalPhoto, alt: `Portrait of ${BRAND.principalName || ''}`.trim() };

  // Acceptance wording adapts while no terms exist rather than citing a version
  // that is not there (open question Q7). Shared with the server's record.
  const terms = (v.terms = v.terms || {});
  v.accept = v.accept || {};
  v.accept.clause = acceptClause(terms);
  // What acceptance means for the hold points, named from this proposal's own list (never a fixed range).
  const codes = list(v.risk && v.risk.holdPoints).map((h) => str(h.code).trim().toUpperCase()).filter(Boolean);
  const later = codes.filter((c) => c !== 'HP1');
  const until = later.length ? ` No blasting proceeds until ${later.length === 1 ? `hold point ${later[0]} is` : `hold points ${later[0]} to ${later[later.length - 1]} are`} met.` : '';
  v.accept.holdNote = `${codes.includes('HP1') ? 'Hold point HP1. ' : ''}Planning and site preparation can begin once this is accepted.${until}`;
  v.accept.holdMet = `${codes.includes('HP1') ? 'Hold point HP1 is met.' : ''}${until}`.trim();

  computeQuote(v);
  return v;
}

function computeQuote(v) {
  const q = (v.quote = v.quote || {});
  const lines = list(q.lines);
  q.lines = lines;
  let totals;
  try { totals = quoteTotals(lines, state.options); }
  catch { totals = null; }
  q.subtotalText = totals && lines.length ? formatAUD(totals.subtotal) : '';
  q.gstText = totals && lines.length ? formatAUD(totals.gst) : '';
  q.totalText = totals && lines.length ? formatAUD(totals.total) : '';
  q.atCostNote = totals && totals.unpriced
    ? (totals.unpriced === 1 ? 'Plus one item at cost + GST.' : `Plus ${totals.unpriced} items at cost + GST.`)
    : '';
  const chosen = lines.filter((l) => l.optional && state.options.has(l.id)).map((l) => str(l.desc));
  q.optionsText = chosen.length ? chosen.join('; ') : '';
  q.totals = totals;
}

/* --------------------------------------------------------------- binding */

function bindFields(v) {
  D.querySelectorAll('[data-field]').forEach((el) => setText(el, get(v, el.dataset.field), el.__def));
  D.querySelectorAll('[data-img]').forEach((img) => setImage(img, get(v, img.dataset.img), state.cfg));
  D.querySelectorAll('[data-paras]').forEach((el) => setParas(el, get(v, el.dataset.paras)));
  D.querySelectorAll('[data-list]').forEach((ul) => fillList(ul, get(v, ul.dataset.list)));
  D.querySelectorAll('[data-locked]').forEach((el) => {
    const line = (v.locked && v.locked[el.dataset.locked]) || (TPL.locked && TPL.locked[el.dataset.locked]);
    el.textContent = line ? fillTokens(line) : '';
  });
  D.querySelectorAll('[data-snap]').forEach((el) => {
    const text = get(v.snap || {}, el.dataset.snap) ?? get(TPL.snap || {}, el.dataset.snap);
    el.textContent = str(text);
  });
  D.querySelectorAll('[data-prefill]').forEach((input) => {
    if (!input.dataset.touched) input.value = str(get(v, input.dataset.prefill));
  });
}

function fillList(ul, value) {
  const items = list(value).map(str).filter((s) => s.trim());
  ul.replaceChildren(...items.map((text) => {
    const li = ul.__tpl.cloneNode(true);
    const slot = li.matches('[data-item]') ? li : li.querySelector('[data-item]');
    if (slot) setRich(slot, text);
    return li;
  }));
}

function fillRow(row, item, i) {
  row.removeAttribute('data-row');
  row.querySelectorAll('[data-col]').forEach((el) => setText(el, item[el.dataset.col]));
  row.querySelectorAll('[data-col-paras]').forEach((el) => setParas(el, item[el.dataset.colParas]));
  row.querySelectorAll('[data-col-list]').forEach((ul) => fillList(ul, item[ul.dataset.colList]));
  row.querySelectorAll('[data-col-img]').forEach((img) => {
    const ok = setImage(img, item[img.dataset.colImg], state.cfg);
    const frame = img.parentElement;
    if (frame) frame.classList.toggle('is-empty', !ok);
  });
  row.querySelectorAll('[data-col-index]').forEach((el) => { el.textContent = String(i + 1).padStart(2, '0'); });
  row.querySelectorAll('[data-col-icon]').forEach((use) => {
    use.setAttribute('href', `/assets/img/icons.svg#${str(item[use.dataset.colIcon]) || 'hard-hat'}`);
  });
  row.querySelectorAll('[data-col-hide-empty]').forEach((el) => { el.hidden = !present(item[el.dataset.colHideEmpty]); });
}

function renderRows(box, items, extra) {
  if (!box.__tpl) return;
  const rows = list(items);
  if (!Array.isArray(items)) {
    // Absent: a container with built-in content (data-rows-default) gets it
    // back; one whose only row is an empty placeholder renders nothing.
    if (box.hasAttribute('data-rows-default')) {
      if (box.innerHTML !== box.__defHTML) box.innerHTML = box.__defHTML;
      box.querySelectorAll('[data-row]').forEach((r) => r.removeAttribute('data-row'));
    } else {
      box.replaceChildren();
    }
    return;
  }
  box.replaceChildren(...rows.map((item, i) => {
    const row = box.__tpl.cloneNode(true);
    fillRow(row, item, i);
    if (extra) extra(row, item, i);
    return row;
  }));
}

function bindRows(v) {
  D.querySelectorAll('[data-rows]').forEach((box) => {
    const path = box.dataset.rows;
    const items = get(v, path);
    if (path === 'scope.matrix') {
      renderRows(box, items, (row, item) => {
        row.querySelectorAll('[data-mark]').forEach((td) => {
          const on = item.party === td.dataset.mark && PARTIES[item.party];
          td.classList.toggle('is-on', Boolean(on));
          td.setAttribute('aria-label', on ? `${td.dataset.label}: responsible` : '');
          td.textContent = '';
          if (on) { const m = D.createElement('span'); m.className = 'mark-box'; td.append(m); }
        });
        if (item.party === 'to-be-agreed') row.classList.add('is-tba');
      });
    } else if (path === 'risk.holdPoints') {
      renderRows(box, items, (row, item) => {
        const chip = row.querySelector('[data-hold-status]');
        if (chip) chip.dataset.state = item.status === 'met' ? 'met' : item.status === 'na' ? 'na' : 'open';
      });
    } else {
      renderRows(box, items);
    }
  });
}

function bindHides(v) {
  D.querySelectorAll('[data-hide-empty]').forEach((el) => { el.hidden = !present(get(v, el.dataset.hideEmpty)); });
}

/* ------------------------------------------------------ special renderers */

function el(tag, cls, text) {
  const n = D.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name) {
  const svg = D.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = D.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function renderParams(v) {
  const body = D.querySelector('[data-params]');
  if (!body) return;
  const rows = (v.params && v.params.rows) || {};
  body.replaceChildren(...PARAMS.map(([key, label]) => {
    const r = rows[key] || {};
    const tr = el('tr');
    const th = el('th', 'term', label); th.scope = 'row';
    const td = el('td');
    td.dataset.label = 'Preliminary value';
    if (present(r.value) && r.tbc !== true) td.textContent = str(r.value);
    else { td.textContent = 'TBC in final blast design'; td.className = 'tbc'; }
    tr.append(th, td);
    return tr;
  }));
}

function renderWorkflow() {
  const ol = D.querySelector('[data-workflow]');
  if (!ol || ol.childElementCount) return;
  for (const s of (TPL.workflow && TPL.workflow.stages) || []) {
    const li = el('li', 'flow-step');
    li.append(el('span', 'flow-n', String(s.n).padStart(2, '0')), el('span', 'flow-title', s.title), el('span', 'flow-line', s.line));
    ol.append(li);
  }
}

function renderTimeline(v) {
  const wrap = D.querySelector('[data-timeline]');
  if (!wrap) return;
  const rowsEl = wrap.querySelector('[data-timeline-rows]');
  const axis = wrap.querySelector('[data-timeline-axis]');
  const phases = list(v.programme.phases).map((p) => ({ ...p, a: parseDate(p.start), b: parseDate(p.end) })).filter((p) => p.a && p.b && p.b >= p.a);
  rowsEl.replaceChildren();
  axis.replaceChildren();
  if (!phases.length) return;
  const min = Math.min(...phases.map((p) => p.a.getTime()));
  const max = Math.max(...phases.map((p) => p.b.getTime())) + 86400000;
  const span = max - min;
  const pct = (t) => ((t - min) / span) * 100;
  axis.append(el('span', 'axis-start', fmtShort(new Date(min).toISOString().slice(0, 10))), el('span', 'axis-end', fmtShort(new Date(max - 86400000).toISOString().slice(0, 10))));
  for (const p of phases) {
    const li = el('li', 'tl-row');
    const label = el('div', 'tl-label');
    label.append(el('span', 'tl-name', str(p.name)), el('span', 'tl-dates', `${fmtShort(p.start)} – ${fmtShort(p.end)}`));
    const track = el('div', 'tl-track');
    const bar = el('span', 'tl-bar');
    bar.style.left = pct(p.a.getTime()) + '%';
    bar.style.width = Math.max(1.5, pct(p.b.getTime() + 86400000) - pct(p.a.getTime())) + '%';
    track.append(bar);
    if (str(p.holdPoint)) {
      const hp = el('span', 'tl-hp', str(p.holdPoint));
      hp.style.left = pct(p.b.getTime() + 86400000) + '%';
      track.append(hp);
    }
    li.append(label, track);
    rowsEl.append(li);
  }
}

function renderQuote(v) {
  const body = D.querySelector('[data-quote-lines]');
  if (!body) return;
  const lines = v.quote.lines;
  const hasOptional = lines.some((l) => l.optional);
  const hint = D.querySelector('[data-quote-hint]');
  if (hint) hint.hidden = !hasOptional;
  body.replaceChildren(...lines.map((line) => {
    const tr = el('tr');
    if (line.optional) tr.classList.add('is-optional');
    if (line.optional && !state.options.has(line.id)) tr.classList.add('is-off');
    const desc = el('th', 'term');
    desc.scope = 'row';
    if (line.optional) {
      const lab = el('label', 'opt');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.options.has(line.id);
      box.disabled = state.optionsLocked === true;
      box.dataset.option = str(line.id);
      lab.append(box, el('span', 'opt-box'), el('span', 'opt-text', str(line.desc)), el('span', 'opt-tag', 'Optional'));
      desc.append(lab);
    } else {
      desc.textContent = str(line.desc);
    }
    let amount;
    try { amount = lineAmountCents(line); } catch { amount = null; }
    // Phones show one calculation line instead of four labelled cells.
    const calc = line.rateCents == null
      ? (BASES[line.basis] || '')
      : `${formatQty(line.qtyHundredths ?? 100)} ${str(line.unit)} × ${formatAUD(line.rateCents)}`.replace(/\s+/g, ' ');
    (desc.querySelector('.opt-text') || desc).append(el('span', 'line-calc', calc));
    const cell = (text, cls, label) => { const td = el('td', cls, text); if (label) td.dataset.label = label; return td; };
    tr.append(
      desc,
      cell(BASES[line.basis] || '', 'basis', 'Basis'),
      cell(line.rateCents == null ? '' : formatQty(line.qtyHundredths ?? 100), 'num', 'Qty'),
      cell(line.rateCents == null ? '' : str(line.unit), 'unit', 'Unit'),
      cell(line.rateCents == null ? '' : formatAUD(line.rateCents), 'num', 'Rate'),
      cell(amount == null ? (line.basis === 'at-cost' ? 'At cost + GST' : '—') : formatAUD(amount), 'num amount', 'Amount'),
    );
    return tr;
  }));

  const dl = D.querySelector('[data-quote-terms]');
  if (dl) {
    const t = v.quote.terms || {};
    const items = TERMS.filter(([k]) => present(t[k])).map(([k, label]) => [label, str(t[k])]);
    if (v.meta.validUntilText) items.push(['Valid until', v.meta.validUntilText]);
    dl.replaceChildren(...items.map(([label, value]) => {
      const div = el('div');
      div.append(el('dt', null, label), el('dd', null, value));
      return div;
    }));
    dl.hidden = !items.length;
  }
}

function refreshQuote() {
  computeQuote(state.view);
  const v = state.view;
  D.querySelectorAll('[data-field^="quote."]').forEach((node) => setText(node, get(v, node.dataset.field), node.__def));
  D.querySelectorAll('[data-quote-lines] tr').forEach((tr) => {
    const box = tr.querySelector('[data-option]');
    if (box) tr.classList.toggle('is-off', !box.checked);
  });
}

function renderAttachments(v) {
  const host = D.querySelector('[data-attachments]');
  if (!host) return;
  const files = list(v.attachments).filter((a) => a.visibility === 'client' || a.visibility === 'on-request');
  host.replaceChildren();
  for (const [key, label] of ATTACH_GROUPS) {
    const group = files.filter((a) => (ATTACH_GROUPS.some(([k]) => k === a.category) ? a.category : 'other') === key);
    if (!group.length) continue;
    const block = el('div', 'att-group');
    const h = el('h3', 'h4', label);
    const ul = el('ul', 'att-list');
    for (const a of group) {
      const li = el('li', 'att');
      const ic = el('span', 'att-ic');
      ic.append(icon('file-text'));
      const body = el('div', 'att-body');
      body.append(el('p', 'att-title', str(a.title)));
      // A library document that lapses says until when (Phase 8); older revisions have no expiresOn.
      const bits = [str(a.docCode), str(a.docRev) ? 'Rev ' + str(a.docRev) : '', fmtDate(a.docDate), str(a.expiresOn) ? 'Current to ' + fmtDate(a.expiresOn) : '',
        Number.isFinite(a.pages) ? `${a.pages} ${a.pages === 1 ? 'page' : 'pages'}` : '', fmtBytes(a.bytes)].filter(Boolean);
      body.append(el('p', 'att-meta', bits.join(' · ')));
      const actions = el('div', 'att-actions');
      if (a.visibility === 'on-request') {
        actions.append(el('span', 'att-request', 'Available on request'));
      } else {
        for (const [action, text, ico] of [['view', 'View', 'eye'], ['download', 'Download', 'download']]) {
          const b = el('button', 'btn btn--secondary btn--sm');
          b.type = 'button';
          b.dataset.attachment = str(a.id);
          b.dataset.action = action;
          b.append(icon(ico), el('span', null, text));
          actions.append(b);
        }
      }
      li.append(ic, body, actions);
      ul.append(li);
    }
    block.append(h, ul);
    host.append(block);
  }
  const sec = D.getElementById('attachments');
  if (sec) sec.dataset.empty = files.length ? '' : '1';
}

// The printed footer line. The @page margin box in print.css reads it from a
// custom property on the root element — set through the CSSOM, so no inline
// style and no CSP exception. (Inserting @page rules through the CSSOM was
// tried first and crashes Chromium's renderer when the rule is read back.)
function setPrintFooter(text) {
  const safe = String(text || '').replace(/["\\\n\r]/g, ' ');
  ROOT.style.setProperty('--print-footer', `"${safe}"`);
}

function renderStatus(v) {
  const chip = D.querySelector('[data-status-chip]');
  if (chip) { chip.dataset.state = str(v.meta.status) || 'draft'; chip.hidden = !v.meta.statusLabel; }
  const demo = D.getElementById('demo-chip');
  if (demo) demo.hidden = v.demo !== true;
  const sup = D.getElementById('superseded');
  if (sup) {
    sup.hidden = !str(v.meta.supersededBy);
    const link = sup.querySelector('[data-current-link]');
    if (link) {
      link.hidden = !str(v.meta.currentHref);
      if (str(v.meta.currentHref)) link.href = v.meta.currentHref;
    }
  }
  setPrintFooter(v.meta.footerLine);
  const register = D.querySelector('[data-ratings]');
  if (register) register.dataset.ratings = TPL.ratingsEnabled === true ? 'on' : 'off';
}

/* -------------------------------------------------------------- sections */

function applyLayout(v) {
  const main = D.getElementById('main');
  const secs = [...main.querySelectorAll(':scope > [data-sec]')];
  const byId = new Map(secs.map((s) => [s.dataset.sec, s]));
  const configured = list(v.layout && v.layout.sections).filter((s) => byId.has(s.id));
  const on = new Map(secs.map((s) => [s.dataset.sec, !DEFAULT_OFF.has(s.dataset.sec)]));
  configured.forEach((s) => on.set(s.id, s.on !== false));

  const middle = configured.map((s) => s.id).filter((id) => !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id));
  const rest = secs.map((s) => s.dataset.sec).filter((id) => !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id) && !middle.includes(id));
  const order = [...PINNED_FIRST, ...middle, ...rest, ...PINNED_LAST];
  const current = secs.map((s) => s.dataset.sec).join('|');
  if (current !== order.join('|')) order.forEach((id) => main.append(byId.get(id)));

  // Sections with nothing in them hide themselves: attachments with no files.
  const autoEmpty = (id) => id === 'attachments' && byId.get(id).dataset.empty === '1';
  let n = 0;
  let paperRun = 0;
  const visible = [];
  for (const id of order) {
    const sec = byId.get(id);
    const show = on.get(id) && !autoEmpty(id);
    sec.hidden = !show;
    if (!show) continue;
    n += 1;
    visible.push(sec);
    const num = String(n).padStart(2, '0');
    sec.dataset.num = num;
    sec.querySelectorAll('[data-secnum]').forEach((s) => { s.textContent = num; });
    if (sec.dataset.surface === 'paper') { sec.dataset.tone = paperRun % 2 ? 'b' : 'a'; paperRun += 1; }
    else paperRun = 0;
  }
  buildIndex(visible);
}

function buildIndex(visible) {
  const make = (host, cls) => {
    if (!host) return;
    host.replaceChildren(...visible.map((sec) => {
      const li = el('li');
      const a = el('a', cls);
      a.href = '#' + sec.id;
      a.dataset.target = sec.id;
      a.append(el('span', 'ix-n', sec.dataset.num), el('span', 'ix-label', sec.dataset.label || ''));
      li.append(a);
      return li;
    }));
  };
  make(D.querySelector('[data-index-list]'), 'rail-link');
  make(D.querySelector('[data-sheet-list]'), 'sheet-link');
  if (state.effects) state.effects.watchSections();
}

/* ------------------------------------------------------------- applyConfig */

export function applyConfig(cfg) {
  captureDefaults();
  state.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  TPL = state.cfg.tpl && typeof state.cfg.tpl === 'object' ? { ...PAGE_TPL, ...state.cfg.tpl } : PAGE_TPL;
  // Optional quote items start from the proposal's own defaults; ticks the
  // client makes survive re-binding (the editor re-applies on every keystroke).
  const lines = list(state.cfg.quote && state.cfg.quote.lines);
  const ids = new Set(lines.filter((l) => l.optional).map((l) => l.id));
  if (!state.optionsSeeded) {
    state.options = new Set(lines.filter((l) => l.optional && l.optionalDefault).map((l) => l.id));
    state.optionsSeeded = true;
  } else {
    state.options = new Set([...state.options].filter((id) => ids.has(id)));
  }
  const v = deriveView(state.cfg);
  state.view = v;
  bindFields(v);
  bindRows(v);
  renderParams(v);
  renderWorkflow();
  renderTimeline(v);
  renderQuote(v);
  renderAttachments(v);
  renderAcceptMode(v);
  renderStatus(v);
  bindHides(v);
  applyLayout(v);
  if (state.effects) state.effects.observe(D);
  return v;
}

/* ----------------------------------------------------------------- images */

export function whenImagesReady(root = D, capMs = 2500) {
  const imgs = [...root.querySelectorAll('img')].filter((img) => img.getAttribute('src') && !img.complete && !img.closest('[hidden]'));
  if (!imgs.length) return Promise.resolve();
  const loads = imgs.map((img) => new Promise((done) => {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }));
  return Promise.race([Promise.all(loads), new Promise((done) => setTimeout(done, capMs))]);
}

/* ---------------------------------------------------------------- effects */

export function initEffects(root = D) {
  if (state.effects) return state.effects;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bar = D.querySelector('#pbar span');
  const flt = D.getElementById('flt');

  // Progress bar, header lift, back-to-top — one rAF-throttled scroll handler.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY;
      const max = D.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
      ROOT.toggleAttribute('data-scrolled', y > 20);
      if (flt) flt.classList.toggle('is-on', y > 600);
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (flt) flt.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); D.getElementById('main').focus({ preventScroll: true }); });

  // Reveal on scroll. Without JS, or with reduced motion, nothing is ever hidden.
  const reveal = reduce || !('IntersectionObserver' in window) ? null : new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('rv-in'); reveal.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  const observe = (scope) => {
    scope.querySelectorAll('[data-reveal]:not(.rv-in)').forEach((n) => (reveal ? reveal.observe(n) : n.classList.add('rv-in')));
  };
  if (!reduce) ROOT.classList.add('motion');
  observe(root);

  // Active section in the index.
  let spy = null;
  const setActive = (id) => {
    D.querySelectorAll('.rail-link, .sheet-link').forEach((a) => {
      if (a.dataset.target === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  };
  const watchSections = () => {
    if (!('IntersectionObserver' in window)) return;
    if (spy) spy.disconnect();
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
    }, { rootMargin: '-42% 0px -52% 0px' });
    D.querySelectorAll('#main > [data-sec]:not([hidden])').forEach((s) => spy.observe(s));
  };
  watchSections();

  // Sections sheet (phones and tablets): a dialog with a focus trap.
  const sheet = D.getElementById('sheet');
  const toggle = D.getElementById('index-toggle');
  let lastFocus = null;
  const closeSheet = () => {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    ROOT.classList.remove('sheet-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (lastFocus) lastFocus.focus();
  };
  const openSheet = () => {
    lastFocus = D.activeElement;
    sheet.hidden = false;
    ROOT.classList.add('sheet-open');
    toggle.setAttribute('aria-expanded', 'true');
    const current = sheet.querySelector('[aria-current]') || sheet.querySelector('a, button');
    if (current) current.focus();
  };
  if (sheet && toggle) {
    toggle.addEventListener('click', () => (sheet.hidden ? openSheet() : closeSheet()));
    sheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-sheet-close]') || e.target.closest('.sheet-link')) closeSheet();
    });
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (e.key !== 'Tab') return;
      const nodes = [...sheet.querySelectorAll('a, button')].filter((n) => !n.closest('[hidden]'));
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && D.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  // Optional quote items.
  D.addEventListener('change', (e) => {
    const box = e.target.closest && e.target.closest('[data-option]');
    if (!box) return;
    if (box.checked) state.options.add(box.dataset.option);
    else state.options.delete(box.dataset.option);
    refreshQuote();
    D.dispatchEvent(new CustomEvent('proposal:option', { detail: { option: box.dataset.option, on: box.checked } }));
  });

  // Prefilled acceptance fields stop following the config once someone types.
  D.addEventListener('input', (e) => { if (e.target.dataset && 'prefill' in e.target.dataset) e.target.dataset.touched = '1'; });

  // Print: everything revealed, terms open, every image loaded. The print CSS
  // already forces [data-reveal] visible, so this is belt and braces for
  // browsers that print before beforeprint has painted.
  const opened = [];
  const beforePrint = () => {
    ROOT.classList.add('printing');
    D.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('rv-in'));
    D.querySelectorAll('details:not([open])').forEach((d) => { d.open = true; opened.push(d); });
    D.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
  };
  const afterPrint = () => {
    ROOT.classList.remove('printing');
    while (opened.length) opened.pop().open = false;
  };
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  D.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    // The gate refreshes short-lived photograph links first, if they are near expiry.
    if (typeof hooks.beforePrint === 'function') { try { await hooks.beforePrint(); } catch { /* print what is loaded */ } }
    beforePrint();
    await whenImagesReady(D, 6000);
    b.disabled = false;
    window.print();
  }));

  // Acceptance and requests for changes (below). The gate sends them; in the
  // editor and the demo the form validates and says plainly that it is a preview.
  initAcceptance();

  // Documents. View opens the viewer (assets/js/pdf-viewer.js, loaded on first
  // use); Download saves the file without leaving the page. Each asks whoever
  // runs the page for a fresh link — the gate for a client, the editor for staff.
  D.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-attachment]');
    if (!b) return;
    const card = b.closest('.att');
    let note = card.querySelector('.att-note');
    if (!note) {
      note = el('p', 'att-note');
      note.setAttribute('role', 'status');
      card.querySelector('.att-body').append(note);
    }
    note.textContent = '';
    if (typeof hooks.attachment !== 'function') { note.textContent = 'Opens in the issued proposal.'; return; }
    const id = b.dataset.attachment;
    const link = (opts) => hooks.attachment(id, opts);
    const said = (err, fallback) => (err && err.userMessage) || fallback;
    let viewer;
    try { viewer = await import('./pdf-viewer.js'); } catch { note.textContent = 'The document viewer could not load. Check your connection and try again.'; return; }
    if (b.dataset.action === 'download') {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      try { await viewer.downloadVia(link); note.textContent = 'Downloaded.'; } catch (err) { note.textContent = said(err, 'The download did not complete. Try again.'); }
      b.disabled = false;
      b.setAttribute('aria-busy', 'false');
      return;
    }
    viewer.openViewer({ title: card.querySelector('.att-title').textContent, meta: card.querySelector('.att-meta').textContent, link });
  });

  state.effects = { observe, watchSections };
  return state.effects;
}

/* -------------------------------------------------------------- acceptance */

const acc = { pad: null, padLoading: null, mode: 'both', status: null };
const hobartWhen = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
const callUs = () => `call ${BRAND.principalName} on ${BRAND.phoneDisplay}`;

/** Which signature the proposal asks for (accept.signature): drawn or typed, typed only, or drawn only. */
function renderAcceptMode(v) {
  const mode = signatureMode(v.accept);
  acc.mode = mode;
  const draw = D.querySelector('[data-sig-draw]');
  const type = D.querySelector('[data-sig-type]');
  const hint = D.querySelector('[data-sig-hint]');
  if (!draw || !type || !hint) return;
  draw.hidden = mode === 'typed';
  type.hidden = mode === 'drawn';
  hint.textContent = mode === 'both' ? 'Draw your signature, or type your full name. Either is enough.'
    : mode === 'typed' ? 'Type your full name, exactly as above.' : 'Draw your signature with a finger, stylus or mouse.';
  type.querySelector('.field-label').textContent = mode === 'both' ? 'Or type your full name' : 'Type your full name';
}

/** The signature pad (assets/js/signature.js) loads as the acceptance comes near. */
function loadPad() {
  if (acc.padLoading) return acc.padLoading;
  const canvas = D.querySelector('[data-sig-canvas]');
  if (!canvas) return Promise.resolve(null);
  acc.padLoading = import('./signature.js')
    .then((m) => { acc.pad = m.attachPad(canvas, { onChange: () => { delete canvas.closest('[data-sig-draw]').dataset.invalid; } }); return acc.pad; })
    .catch(() => { acc.padLoading = null; return null; });
  return acc.padLoading;
}

function defaultOptions() {
  return new Set(list(state.view.quote && state.view.quote.lines).filter((l) => l.optional && l.optionalDefault).map((l) => l.id));
}

/** Lock (or release) the quotation's optional items, e.g. to what was accepted. */
function lockOptions(locked, options) {
  state.optionsLocked = locked;
  if (options) state.options = new Set(options);
  D.querySelectorAll('[data-option]').forEach((b) => { b.checked = state.options.has(b.dataset.option); b.disabled = locked; });
  refreshQuote();
}

/**
 * What the server says about this revision's acceptance (the gate asks after
 * unlocking): { accepted, open, earlier }. null = unknown (editor, demo).
 */
export function setAcceptance(status) {
  acc.status = status || null;
  const form = D.querySelector('[data-accept-form]');
  const done = D.querySelector('[data-accept-done]');
  const banner = D.querySelector('[data-accept-banner]');
  const changes = D.querySelector('[data-changes-form]');
  if (!form || !done || !banner) return;
  banner.hidden = true;
  banner.removeAttribute('data-tone');
  const a = status && status.accepted;
  if (a) {
    form.hidden = true;
    if (changes) changes.hidden = true;
    done.hidden = false;
    done.querySelector('[data-done-label]').textContent = a.kind === 'staff' ? `Accepted — recorded by ${BRAND.name}` : 'Accepted';
    done.querySelector('[data-done-by]').textContent = [a.name, a.position, a.company].filter(Boolean).join(', ');
    done.querySelector('[data-done-when]').textContent = hobartWhen(a.acceptedAt);
    const names = list(state.view.quote && state.view.quote.lines).filter((l) => l.optional && (a.options || []).includes(l.id)).map((l) => str(l.desc));
    done.querySelector('[data-done-options]').textContent = names.length ? names.join('; ') : 'None selected';
    done.querySelector('[data-done-total]').textContent = a.totalText || '—';
    lockOptions(true, a.options || []);
    return;
  }
  done.hidden = true;
  if (state.optionsLocked) lockOptions(false, defaultOptions());
  if (status && status.open === false) {
    form.hidden = true;
    if (changes) changes.hidden = true;
    banner.hidden = false;
    banner.dataset.tone = 'info';
    banner.textContent = 'This is an earlier revision, kept for reference. Only the current revision can be accepted.';
    return;
  }
  form.hidden = false;
  if (status && status.earlier) {
    banner.hidden = false;
    banner.textContent = `Revised after acceptance — re-acceptance required. Revision ${status.earlier.rev} was accepted on ${hobartWhen(status.earlier.acceptedAt)}; this revision needs accepting again.`;
  }
}

function initAcceptance() {
  const form = D.querySelector('[data-accept-form]');
  if (!form) return;
  const note = form.querySelector('[data-accept-note]');
  const canvas = form.querySelector('[data-sig-canvas]');
  const say = (el, tone, text) => { el.dataset.tone = tone; el.textContent = text; };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { loadPad(); io.disconnect(); } }, { rootMargin: '900px 0px' });
    io.observe(form);
  } else loadPad();
  if (canvas) canvas.addEventListener('pointerenter', () => loadPad(), { once: true });
  form.querySelector('[data-sig-clear]')?.addEventListener('click', async () => { const pad = await loadPad(); if (pad) pad.clear(); });
  form.addEventListener('input', (e) => { if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid'); });
  form.addEventListener('change', (e) => { const c = e.target.closest && e.target.closest('.check'); if (c) delete c.dataset.invalid; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (n) => String(form.elements[n].value || '').trim();
    const flagged = [];
    const mark = (name) => {
      if (name === 'drawn' || name === 'signature') {
        const pad = form.querySelector('[data-sig-draw]');
        if (pad && !pad.hidden) { pad.dataset.invalid = 'true'; flagged.push(canvas); }
        if (name === 'signature' && !form.querySelector('[data-sig-type]').hidden) mark('typed');
        return;
      }
      const field = form.elements[name];
      if (!field) return;
      if (field.type === 'checkbox') field.closest('.check').dataset.invalid = 'true';
      else field.setAttribute('aria-invalid', 'true');
      flagged.push(field);
    };
    if (val('name').length < 2) mark('name');
    if (!val('position')) mark('position');
    if (!val('company')) mark('company');
    if (!EMAIL_RE.test(val('email'))) mark('email');
    if (!form.elements.authority.checked) mark('authority');
    if (!form.elements.accept.checked) mark('accept');
    const pad = acc.mode === 'typed' ? null : (acc.pad || await loadPad());
    const drawn = !!(pad && !pad.isEmpty());
    const typed = acc.mode === 'drawn' ? '' : val('typed');
    let why = '';
    if (typed && !sameName(typed, val('name'))) { mark('typed'); why = 'The typed signature must be your full name, exactly as entered above.'; }
    else if (acc.mode === 'typed' && !typed) { mark('typed'); why = 'Type your full name to sign.'; }
    else if (acc.mode === 'drawn' && !drawn) { mark('drawn'); why = 'Draw your signature to sign.'; }
    else if (acc.mode === 'both' && !typed && !drawn) { mark('signature'); why = 'Sign by drawing your signature or typing your full name.'; }
    const missing = flagged.some((f) => f !== canvas && f.name !== 'typed');
    if (missing || why) {
      say(note, 'error', [missing ? 'Please complete every field and both confirmations; the ones still needed are marked.' : '', why].filter(Boolean).join(' '));
      if (flagged[0]) flagged[0].focus();
      return;
    }
    if (typeof hooks.accept !== 'function') {
      say(note, 'info', 'Preview only — online acceptance opens when this proposal is issued.');
      return;
    }
    const go = form.querySelector('[data-accept-go]');
    go.disabled = true;
    go.textContent = 'Accepting…';
    say(note, 'info', '');
    const totals = state.view.quote && state.view.quote.totals;
    let out;
    try {
      out = await hooks.accept({
        name: val('name'), position: val('position'), company: val('company'), email: val('email'), authority: true, accept: true,
        typed, drawn: drawn ? pad.toPngBase64() : '', options: [...state.options], totalCents: totals ? totals.total : null,
      });
    } catch { out = { status: 0, json: {} }; }
    go.disabled = false;
    go.textContent = 'Accept proposal';
    const j = out.json || {};
    if ((j.accepted || j.already) && j.acceptance) {
      setAcceptance({ accepted: j.acceptance, open: false });
      const done = D.querySelector('[data-accept-done]');
      if (done) done.focus();
      return;
    }
    if (out.status === 422) {
      (j.fields || []).forEach(mark);
      say(note, 'error', 'Some details need checking. They are marked.');
    } else if (out.status === 409 && j.error === 'total') {
      say(note, 'error', `The total has changed since this page was opened (it is now ${j.totalText}). Reload the page to see the current figures, then accept.`);
    } else if (out.status === 429) {
      say(note, 'error', 'Too many attempts from this connection. Wait a few minutes and try again.');
    } else if (out.status === 410) {
      say(note, 'error', `This proposal can no longer be accepted from this page. Reload it, or ${callUs()}.`);
    } else {
      say(note, 'error', `The acceptance did not go through and nothing was recorded. Try again, or ${callUs()}.`);
    }
  });

  // Request changes: a short message to the office instead of accepting.
  const open = form.querySelector('[data-request-changes]');
  const changes = D.querySelector('[data-changes-form]');
  if (!open || !changes) return;
  const cnote = changes.querySelector('[data-changes-note]');
  const show = (on) => {
    changes.hidden = !on;
    open.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (!on) return;
    for (const k of ['name', 'email']) if (!changes.elements[k].value) changes.elements[k].value = form.elements[k].value;
    changes.scrollIntoView({ block: 'nearest' });
    changes.elements.message.focus();
  };
  open.addEventListener('click', () => show(changes.hidden));
  changes.querySelector('[data-changes-cancel]').addEventListener('click', () => { show(false); open.focus(); });
  changes.addEventListener('input', (e) => { if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid'); });
  changes.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (n) => String(changes.elements[n].value || '').trim();
    const bad = [];
    if (val('name').length < 2) bad.push('name');
    if (!EMAIL_RE.test(val('email'))) bad.push('email');
    if (val('message').length < 5) bad.push('message');
    bad.forEach((n) => changes.elements[n].setAttribute('aria-invalid', 'true'));
    if (bad.length) { say(cnote, 'error', 'Please give your name, an email address and what you would like changed.'); changes.elements[bad[0]].focus(); return; }
    if (typeof hooks.requestChanges !== 'function') { say(cnote, 'info', 'Preview only — requests are sent from the issued proposal.'); return; }
    const go = changes.querySelector('[data-changes-go]');
    go.disabled = true;
    let out;
    try { out = await hooks.requestChanges({ name: val('name'), email: val('email'), message: changes.elements.message.value.slice(0, LIMITS.message) }); }
    catch { out = { status: 0, json: {} }; }
    go.disabled = false;
    if (out.status === 200) {
      changes.querySelectorAll('input, textarea, button[type="submit"]').forEach((n) => { n.disabled = true; });
      say(cnote, 'info', `Sent. ${BRAND.principalName} will be in touch. This proposal stays open in the meantime.`);
    } else if (out.status === 429) say(cnote, 'error', 'Too many requests from this connection. Wait a while, or email us instead.');
    else say(cnote, 'error', `The request did not go through. Try again, or ${callUs()}.`);
  });
}

/* -------------------------------------------------------------------- boot */

/**
 * Hooks for whoever runs the page — the gate (assets/js/gate.js) or the editor:
 *   issued        true on a client's issued proposal
 *   beforePrint   async () => {}   refresh anything that has gone stale
 *   attachment    async (cardId, { download }) => { url, name, bytes }   a fresh link to one document
 */
const hooks = {};
export function setHooks(h) { Object.assign(hooks, h); }

window.applyConfig = applyConfig;
window.initEffects = initEffects;
window.whenImagesReady = whenImagesReady;
window.proposalState = () => ({ options: [...state.options], totals: state.view.quote && state.view.quote.totals });

async function boot() {
  ROOT.classList.add('js');
  // The gate (Phase 3) decrypts and the editor loads its draft; each then
  // calls applyConfig + initEffects itself.
  if (ROOT.dataset.boot === 'gate' || ROOT.dataset.boot === 'editor') return;
  if (ROOT.dataset.boot === 'fixture' && ROOT.dataset.fixture) {
    try {
      const res = await fetch(ROOT.dataset.fixture, { cache: 'no-store' });
      applyConfig(await res.json());
    } catch {
      applyConfig({});
    }
  } else {
    applyConfig({});
  }
  await whenImagesReady(D.getElementById('cover') || D, 1500);
  initEffects(D);
  ROOT.classList.add('ready');
}
boot();
