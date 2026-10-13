/**
 * What each section's panel lets staff edit, in page order (docs/architecture.md §3).
 * Field paths are config paths. Library inserts copy text into the proposal and
 * record what was used (cfg.presetsUsed), so the checklist can ask for the
 * wording to be reviewed for this site before it goes out.
 */
import { h, icon, toPath, fillTokens, isConfirmValue, clone } from './dom.js';
import { renderField, note } from './fields.js';
import { attachBox } from './attachments.js';
import { DOC_TYPES, STATUS } from '../schema.js';
import { BASES, lineAmountCents, quoteTotals, formatAUD } from '../money.js';

const opts = (obj) => Object.entries(obj);
const PARTY = (ctx) => [['texc', ctx.BRAND.name], ['client', 'Client'], ['shared', 'Shared'], ['to-be-agreed', 'To be agreed']];
const HOLD = [['open', 'Open'], ['met', 'Met'], ['na', 'Not applicable']];
const CATEGORIES = [['project', 'Project documents'], ['risk', 'Risk and compliance'], ['drawings', 'Drawings and plans'], ['certificates', 'Certificates and insurance'], ['other', 'Other']];
const PARAMS = [['holesPerShot', 'Holes per shot'], ['shots', 'Number of shots / areas'], ['holeDiameter', 'Hole diameter'], ['depthRange', 'Depth range'], ['burdenSpacing', 'Burden and spacing'], ['stemming', 'Stemming'], ['initiation', 'Initiation system'], ['mic', 'Maximum instantaneous charge'], ['powderFactor', 'Powder factor (unit to confirm, CCR-13)'], ['containment', 'Matting and containment']];
const TERMS = [['minimum', 'Minimum engagement'], ['standby', 'Standby'], ['travel', 'Travel'], ['mobilisation', 'Mobilisation and accommodation'], ['invoicing', 'Invoicing'], ['payment', 'Payment terms']];
const LOGISTICS = [['explosives-logistics', 'integrate'], ['explosives-logistics', 'safety'], ['magazine-management', 'safety'], ['magazine-staging', 'safety']];

let lineSeq = 0;
const newLineId = () => `l${Date.now().toString(36)}${(lineSeq += 1)}`;

/** Insert library content: write it, and record it so the checklist asks for a review. */
function insert(ctx, { path, value, id, name, confirm, append = false }) {
  const filled = fillTokens(clone(value), ctx.cfg());
  const current = ctx.get(path);
  const next = append && Array.isArray(current) ? [...current, ...filled] : filled;
  const used = (ctx.get('presetsUsed') || []).filter((u) => !(u.id === id && u.path === path));
  if (confirm) used.push({ id, path, name, confirm });
  ctx.set('presetsUsed', used.length ? used : undefined, { quiet: true });
  ctx.set(path, next, { structural: true });
}

function lockedLine(ctx, key, label) {
  const text = ctx.TPL.locked?.[key] ? ctx.TPL.locked[key].replace(/\{(\w+)\}/g, (m, k) => ctx.BRAND[k] || m) : '';
  return h('div', { class: 'ed-locked' }, h('p', { class: 'ed-label' }, icon('lock'), ` ${label}`), h('p', { class: 'ed-locked-text', text }), h('p', { class: 'ed-hint', text: 'Fixed wording (content/locked-lines.json). It cannot be reworded per proposal.' }));
}

/* ------------------------------------------------------------- services */

function servicesPicker(ctx) {
  const chosen = ctx.get('scope.services') || [];
  const box = h('div', { class: 'ed-field' }, h('p', { class: 'ed-label' }, 'Services', h('span', { class: 'ed-req', text: ' *' })));
  const live = (ctx.TPL.services || []).filter((s) => !s.pending);
  const list = h('div', { class: 'ed-services' });
  for (const s of live) {
    const on = chosen.some((c) => c.slug === s.slug);
    const id = `svc-${s.slug}`;
    const cb = h('input', { type: 'checkbox', id, class: 'ed-check' });
    cb.checked = on;
    cb.addEventListener('change', () => {
      const now = ctx.get('scope.services') || [];
      ctx.set('scope.services', cb.checked ? [...now, { slug: s.slug }] : now.filter((c) => c.slug !== s.slug), { structural: true });
    });
    list.append(h('div', { class: 'ed-svc' }, cb, h('label', { for: id }, icon(ctx.TPL.serviceIcons?.[s.slug] || 'hard-hat'), h('span', { text: s.name }))));
  }
  box.append(list, h('p', { class: 'ed-hint', text: 'Remote Area Operations and Marine & Coastal are in development on the website and cannot be proposed.' }));
  chosen.forEach((c, i) => {
    const s = live.find((x) => x.slug === c.slug);
    if (!s) return;
    const base = ['scope', 'services', i];
    const card = h('div', { class: 'ed-row' }, h('div', { class: 'ed-row-head' }, h('span', { class: 'ed-row-title', text: s.name })));
    card.append(renderField({ type: 'paras', path: [...base, 'scopeText'], label: 'Scope text', help: 'Starts as the website wording for this service. Leave it blank to use that wording.', placeholder: s.overview.join('\n\n'), confirm: false }, ctx));
    if (c.safetyUnlockedBy && !ctx.isAdmin()) {
      card.append(h('div', { class: 'ed-locked' }, h('p', { class: 'ed-label' }, icon('lock'), ` Safety line — unlocked by ${c.safetyUnlockedBy}`), h('p', { class: 'ed-locked-text', text: c.safety || '' }), h('p', { class: 'ed-hint', text: 'Only an administrator can reword it.' })));
      card.append(h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => { const n = clone(ctx.get('scope.services')); delete n[i].safetyUnlockedBy; delete n[i].safety; ctx.set('scope.services', n, { structural: true }); } }, 'Restore the website safety line'));
    } else if (c.safetyUnlockedBy) {
      card.append(renderField({ type: 'area', path: [...base, 'safety'], label: `Safety line — unlocked by ${c.safetyUnlockedBy}`, confirm: false }, ctx));
      card.append(h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => { const n = clone(ctx.get('scope.services')); delete n[i].safetyUnlockedBy; delete n[i].safety; ctx.set('scope.services', n, { structural: true }); } }, 'Restore the website safety line'));
    } else {
      card.append(h('div', { class: 'ed-locked' }, h('p', { class: 'ed-label' }, icon('lock'), ' Safety line (website, compliance-driven)'), h('p', { class: 'ed-locked-text', text: s.safety }),
        ctx.isAdmin()
          ? h('button', {
            type: 'button', class: 'ed-linkbtn', onclick: () => {
              if (!window.confirm('Unlocking a compliance line is recorded against your name, and the proposal can then only be published by an administrator. Unlock it?')) return;
              const n = clone(ctx.get('scope.services'));
              n[i].safetyUnlockedBy = ctx.who().email;
              n[i].safety = s.safety;
              ctx.set('scope.services', n, { structural: true });
            },
          }, 'Unlock (administrator)')
          : h('p', { class: 'ed-hint', text: 'Only an administrator can unlock this line.' })));
    }
    box.append(card);
  });
  return box;
}

/* ------------------------------------------------------------- the panels */

export function panelFor(id, ctx) {
  const L = ctx.LIB;
  const regionOpts = (ctx.TPL.regions || []).map((r) => [r, r]);
  switch (id) {
    case 'cover': return [
      { type: 'select', path: 'meta.docType', label: 'Document type', options: opts(DOC_TYPES), noBlank: true, confirm: false },
      { type: 'select', path: 'meta.status', label: 'Status shown to the client', options: [['preliminary', STATUS.preliminary], ['issued', STATUS.issued]], noBlank: true, confirm: false, help: `The chip at the top of the client’s page. “Preliminary - For Review” is ${ctx.BRAND.name}’s own wording.` },
      { type: 'text', path: 'meta.project', label: 'Project', required: true, placeholder: 'e.g. Proposed specialist controlled rock removal' },
      { type: 'text', path: 'meta.siteLocality', label: 'Site locality', required: true, help: 'The suburb or locality only. Never a street address or coordinates.' },
      { type: 'select', path: 'meta.siteRegion', label: 'Region', options: regionOpts },
      { type: 'text', path: 'client.company', label: 'Client company', required: true },
      { type: 'text', path: 'client.contactName', label: 'Client contact', required: true },
      { type: 'text', path: 'client.contactPosition', label: 'Contact position' },
      { type: 'email', path: 'client.email', label: 'Client email', required: true, help: 'Used to send the link. Never shown on the page.', confirm: false },
      { type: 'date', path: 'meta.validUntil', label: 'Valid until', required: true, confirm: false, help: 'The client link stays open for 30 days after this date.' },
      { type: 'custom', render: () => {
        const p = ctx.proposal && ctx.proposal();
        const current = p && (p.revisions || []).find((r) => r.current);
        return h('div', { class: 'ed-field' }, h('p', { class: 'ed-label', text: 'Reference and issue date' }),
          h('p', { class: 'ed-locked-text', text: p && p.reference ? `${p.reference}${current ? ` · Rev ${current.label} issued ${new Date(current.publishedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}` : 'Allocated when it is first published.' }),
          h('p', { class: 'ed-hint', text: 'Set by the system at publish, never typed.' }));
      } },
      { type: 'text', path: 'meta.preparedBy', label: 'Prepared by', placeholder: ctx.BRAND.principalName },
      { type: 'image', path: 'cover.image', label: 'Cover photograph', slot: 'cover', required: true, credit: true },
    ];
    case 'letter': return [
      { type: 'text', path: 'letter.greetingName', label: 'Dear …', help: 'Usually the contact’s first name.' },
      { type: 'paras', path: 'letter.body', label: 'Letter', required: true, rows: 10 },
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'letter.body', value: L.letterTemplate.paras, id: 'letter-template', name: 'Covering letter', confirm: L.letterTemplate.confirm }) }, icon('book-open'), h('span', { text: 'Insert letter template' }))) },
      { type: 'text', path: 'letter.signoffName', label: 'Signed', placeholder: ctx.BRAND.principalName },
      { type: 'text', path: 'letter.signoffRole', label: 'Role', placeholder: ctx.BRAND.principalRole },
      { type: 'image', path: 'letter.portrait', label: 'Portrait', slot: 'portrait' },
    ];
    case 'glance': return [
      { type: 'note', text: 'Built from the rest of the proposal: services, site, programme, quotation, hold points. Override the wording of three cards below if needed.' },
      { type: 'text', path: 'glance.startText', label: 'Proposed start (override)' },
      { type: 'text', path: 'glance.durationText', label: 'Estimated duration (override)', help: 'Keep it short — it sits in a card.' },
      { type: 'text', path: 'glance.leadTimeText', label: 'Mobilisation lead time (override)' },
    ];
    case 'about': return [
      { type: 'note', tone: 'lock', text: 'Copied from the website’s About page when the proposal is published, so a later website change never alters an issued proposal. Not edited per proposal (C30).' },
    ];
    case 'understanding': return [
      { type: 'paras', path: 'understanding.paras', label: 'What we understand', required: true, rows: 9 },
      { type: 'rows', path: 'understanding.photos', label: 'Photographs', max: 6, addLabel: 'Add a photograph', help: 'Real project imagery only, captioned as what it is.',
        title: (r, i) => r.title || `Photograph ${i + 1}`,
        columns: [
          { type: 'image', path: 'image', label: 'Photograph', slot: 'photo', required: true },
          { type: 'text', path: 'title', label: 'Title', placeholder: '1. Pre-existing condition' },
          { type: 'area', path: 'caption', label: 'Caption', rows: 2 },
          { type: 'text', path: 'credit', label: 'Credit', placeholder: `${ctx.BRAND.name} photo · Client photo` },
        ] },
      { type: 'image', path: 'understanding.sitePlan', label: 'Approved site plan', slot: 'plan', help: 'Only a plan the client has approved. It is labelled “APPROVED PROJECT MAP — DO NOT REDRAW OR INFER BOUNDARIES”.' },
      { type: 'text', path: 'understanding.sitePlan.caption', label: 'Site plan caption' },
      { type: 'text', path: 'understanding.callout.lead', label: 'Status callout — lead', placeholder: 'Preliminary status:' },
      { type: 'area', path: 'understanding.callout.text', label: 'Status callout — text', rows: 4 },
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'understanding.callout', value: { lead: L.statusCallout.lead, text: L.statusCallout.text }, id: 'status-callout', name: 'Status callout' }) }, icon('book-open'), h('span', { text: 'Insert status callout' }))) },
    ];
    case 'scope': return [
      { type: 'custom', render: servicesPicker },
      { type: 'lines', path: 'scope.inclusions', label: 'Included' },
      { type: 'lines', path: 'scope.exclusions', label: 'Not included' },
      { type: 'rows', path: 'scope.matrix', label: 'Who is responsible for what', addLabel: 'Add an item', noDuplicate: true,
        title: (r) => (isConfirmValue(r.item) ? 'Item' : r.item) || 'Item',
        columns: [
          { type: 'text', path: 'item', label: 'Item', confirm: false },
          { type: 'select', path: 'party', label: 'Responsible', options: PARTY(ctx), blank: 'CONFIRM — not decided', structural: true },
          { type: 'text', path: 'note', label: 'Note', confirm: false },
        ],
        newRow: () => ({ item: '', party: { $confirm: 'Who is responsible' } }),
        presets: [{ label: 'Insert the standard items', insert: (c) => insert(c, { path: 'scope.matrix', value: L.matrixItems.map((item) => ({ item, party: { $confirm: `Who is responsible for ${item.toLowerCase()}` } })), id: 'matrix-items', name: 'Responsibility items' }) }] },
    ];
    case 'site': return [
      { type: 'rows', path: 'site.meta', label: 'Site details', addLabel: 'Add a detail', noDuplicate: true, title: (r) => r.label || 'Detail',
        columns: [{ type: 'text', path: 'label', label: 'Label', confirm: false }, { type: 'area', path: 'value', label: 'Value', rows: 2 }],
        presets: [{ label: 'Insert the standard labels', insert: (c) => insert(c, { path: 'site.meta', value: ['Site', 'Region', 'Access', 'Terrain', 'Nearest structures / receptors', 'Services', 'Environmental controls'].map((label) => ({ label, value: { $confirm: label } })), id: 'site-labels', name: 'Site detail labels' }) }] },
      { type: 'note', text: 'Describe distances and receptors qualitatively unless George supplies figures.' },
      { type: 'lines', path: 'site.conditions', label: 'Identified site conditions' },
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'site.conditions', value: L.siteConditions.items, id: 'site-conditions', name: 'Identified site conditions', confirm: L.siteConditions.confirm }) }, icon('book-open'), h('span', { text: 'Insert Chalmers Lane conditions' }))) },
      { type: 'rows', path: 'site.photos', label: 'Site photographs', max: 3, addLabel: 'Add a photograph', title: (r, i) => r.title || `Photograph ${i + 1}`,
        columns: [{ type: 'image', path: 'image', label: 'Photograph', slot: 'photo', required: true }, { type: 'text', path: 'title', label: 'Title' }, { type: 'area', path: 'caption', label: 'Caption', rows: 2 }, { type: 'text', path: 'credit', label: 'Credit' }] },
      { type: 'rows', path: 'site.constraints', label: 'Constraints and control intent', addLabel: 'Add a constraint', title: (r) => r.constraint || 'Constraint',
        columns: [{ type: 'text', path: 'constraint', label: 'Constraint' }, { type: 'area', path: 'intent', label: 'Control intent', rows: 3 }],
        presets: [{ label: 'Insert Chalmers Lane constraints', insert: (c) => insert(c, { path: 'site.constraints', value: L.constraints.rows, id: 'constraints', name: 'Constraints and control intent', confirm: L.constraints.confirm }) }] },
    ];
    case 'method': return [
      { type: 'area', path: 'method.intro', label: 'Introduction', rows: 4 },
      { type: 'rows', path: 'method.steps', label: 'Steps', addLabel: 'Add a step', title: (r, i) => `${String(i + 1).padStart(2, '0')} ${r.title || ''}`,
        columns: [{ type: 'text', path: 'title', label: 'Step' }, { type: 'area', path: 'detail', label: 'Detail', rows: 4 }],
        presets: L.methodPresets.map((p) => ({ label: `Insert: ${p.name}`, insert: (c) => { insert(c, { path: 'method.intro', value: p.intro, id: `${p.id}-intro`, name: `${p.name} — introduction` }); insert(c, { path: 'method.callouts', value: p.callouts, id: `${p.id}-callouts`, name: `${p.name} — callout` }); insert(c, { path: 'method.steps', value: p.steps, id: p.id, name: `Work process — ${p.name}`, confirm: p.confirm }); } })) },
      { type: 'rows', path: 'method.callouts', label: 'Callouts', addLabel: 'Add a callout', title: (r, i) => `Callout ${i + 1}`,
        columns: [{ type: 'text', path: 'lead', label: 'Lead (bold)', confirm: false }, { type: 'area', path: 'text', label: 'Text', rows: 3 }] },
    ];
    case 'params': return [
      { type: 'note', tone: 'warn', text: 'Admin only. Whether quantities such as maximum instantaneous charge or powder factor ever appear on a link-shared page is George’s decision (Q9). Leave “TBC” ticked unless he supplies a value.' },
      { type: 'custom', render: () => lockedLine(ctx, 'paramsLine', 'Shown on the page') },
      ...PARAMS.flatMap(([k, label]) => [
        { type: 'text', path: `params.rows.${k}.value`, label },
        { type: 'check', path: `params.rows.${k}.tbc`, label: 'TBC in final blast design', structural: true },
      ]),
    ];
    case 'env': return [
      { type: 'area', path: 'env.monitoring', label: 'Monitoring approach', rows: 4 },
      { type: 'lines', path: 'env.locations', label: 'Monitoring locations', help: 'Described qualitatively — no coordinates.' },
      { type: 'custom', render: () => lockedLine(ctx, 'envLimitsNote', 'Limits note') },
      { type: 'rows', path: 'env.limits.rows', label: 'Limits from the site approval', addLabel: 'Add a limit', help: 'Only limits the client has supplied. Every row needs its source.', title: (r) => r.parameter || 'Limit',
        columns: [{ type: 'text', path: 'parameter', label: 'Parameter', confirm: false }, { type: 'text', path: 'limit', label: 'Limit', confirm: false }, { type: 'text', path: 'source', label: 'Source (document and clause)', required: true, confirm: false }] },
      { type: 'rows', path: 'env.controls', label: 'Flyrock, dust and noise controls', addLabel: 'Add a control', title: (r) => r.topic || 'Control',
        columns: [{ type: 'text', path: 'topic', label: 'Effect' }, { type: 'area', path: 'text', label: 'Control', rows: 3 }] },
      { type: 'area', path: 'env.neighbours', label: 'Neighbour notification', rows: 3 },
    ];
    case 'risk': return [
      { type: 'paras', path: 'risk.intro', label: 'Purpose and status', rows: 7 },
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'risk.intro', value: L.riskIntro.paras, id: 'risk-intro', name: 'Purpose and status', confirm: L.riskIntro.confirm }) }, icon('book-open'), h('span', { text: 'Insert Chalmers Lane wording' }))) },
      { type: 'custom', render: () => lockedLine(ctx, 'noBlastingUntil', 'Always shown') },
      { type: 'rows', path: 'risk.hazards', label: 'Preliminary hazard and control register', addLabel: 'Add a hazard', title: (r) => r.hazard || 'Hazard',
        help: `Residual ratings stay hidden until ${ctx.BRAND.name} supplies its Risk Level Table (CCR-03).`,
        columns: [{ type: 'text', path: 'hazard', label: 'Hazard' }, { type: 'area', path: 'control', label: 'Preliminary control', rows: 3 }],
        presets: L.hazardPresets.map((p) => ({
          label: p.rows.length ? `Insert: ${p.name}` : `${p.name} — none supplied yet`,
          insert: (c) => {
            if (!p.rows.length) { window.alert(`${p.missing}. Nothing to insert.`); return; }
            insert(c, { path: 'risk.hazards', value: p.rows, id: p.id, name: `Hazard register — ${p.name}`, confirm: p.confirm });
          },
        })) },
      { type: 'rows', path: 'risk.holdPoints', label: 'Hold points', addLabel: 'Add a hold point', title: (r) => `${r.code || 'HP'} ${r.title || ''}`,
        columns: [{ type: 'text', path: 'code', label: 'Code', confirm: false }, { type: 'text', path: 'title', label: 'Title' }, { type: 'area', path: 'requirement', label: 'Requirement', rows: 2 }, { type: 'select', path: 'status', label: 'Status', options: HOLD, noBlank: true, confirm: false, structural: true }],
        presets: L.holdPointPresets.map((p) => ({ label: `Insert: ${p.name}`, insert: (c) => insert(c, { path: 'risk.holdPoints', value: p.rows, id: p.id, name: `Hold points — ${p.name}`, confirm: p.confirm }) })) },
      { type: 'paras', path: 'risk.review', label: 'Review and variation', rows: 6 },
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'risk.review', value: L.riskReview.paras, id: 'risk-review', name: 'Review and variation', confirm: L.riskReview.confirm }) }, icon('book-open'), h('span', { text: 'Insert Chalmers Lane wording' }))) },
    ];
    case 'docs': return [
      { type: 'custom', render: docsPicker },
      { type: 'rows', path: 'docs.projectDocs', label: 'Project documents', addLabel: 'Add a document', title: (r) => r.title || 'Document',
        columns: [{ type: 'text', path: 'title', label: 'Title', confirm: false }, { type: 'text', path: 'note', label: 'Note', confirm: false }] },
      { type: 'check', path: 'docs.workflow.on', label: `Show ${ctx.BRAND.name}’s project workflow`, structural: true, help: `Its source is “Draft — not approved” (C21). Leave it off for real proposals until ${ctx.BRAND.name} approves it.` },
    ];
    case 'logistics': return [
      { type: 'custom', render: () => lockedLine(ctx, 'logisticsRule', 'The rule for this section') },
      { type: 'note', tone: 'warn', text: `Fixed lines only — this section takes no free text (C36). The lines still need ${ctx.BRAND.name} sign-off as proposal wording (C20).` },
      { type: 'custom', render: logisticsPicker },
    ];
    case 'team': return [
      { type: 'rows', path: 'team.people', label: 'People', addLabel: 'Add a person', noDuplicate: true,
        title: (r, i, c) => (c.TPL.people || []).find((p) => p.slug === r.personId)?.name || 'Person',
        columns: [{ type: 'select', path: 'personId', label: 'Person', options: (c) => (c.TPL.people || []).map((p) => [p.slug, `${p.name} — ${p.role}`]), noBlank: true, confirm: false, structural: true }],
        newRow: (c) => ({ personId: (c.TPL.people || [])[0]?.slug }),
        extra: competencyPicker },
      { type: 'custom', render: () => h('div', { class: 'ed-locked' }, h('p', { class: 'ed-label' }, icon('lock'), ' Policy line (website)'), h('p', { class: 'ed-locked-text', text: `${ctx.TPL.snap?.competency?.heading || ''} ${ctx.TPL.snap?.competency?.body || ''}` })) },
    ];
    case 'programme': return [
      { type: 'date', path: 'programme.start', label: 'Proposed start', confirm: false },
      { type: 'date', path: 'programme.finish', label: 'Proposed finish', confirm: false },
      { type: 'text', path: 'programme.duration', label: 'Duration' },
      { type: 'text', path: 'programme.shiftPattern', label: 'Shift pattern' },
      { type: 'text', path: 'programme.leadTime', label: 'Mobilisation lead time' },
      { type: 'rows', path: 'programme.phases', label: 'Phases', addLabel: 'Add a phase', title: (r) => r.name || 'Phase',
        columns: [{ type: 'text', path: 'name', label: 'Phase', confirm: false }, { type: 'date', path: 'start', label: 'Start', confirm: false }, { type: 'date', path: 'end', label: 'End', confirm: false },
          { type: 'select', path: 'holdPoint', label: 'Hold point at the end', options: ['HP1', 'HP2', 'HP3', 'HP4', 'HP5'].map((x) => [x, x]), blank: 'None', confirm: false }] },
      { type: 'lines', path: 'programme.dependencies', label: 'What we need from the client' },
    ];
    case 'quote': return [
      { type: 'rows', path: 'quote.lines', label: 'Lines', addLabel: 'Add a line', newId: newLineId,
        title: (r, i) => `${i + 1}. ${r.desc || 'Line'}${r.optional ? ' (optional)' : ''}`,
        newRow: () => ({ id: newLineId(), desc: '', basis: 'hourly', unit: 'hr', qtyHundredths: 100, rateCents: null }),
        columns: [
          { type: 'text', path: 'desc', label: 'Description', confirm: false },
          { type: 'select', path: 'basis', label: 'Basis', options: opts(BASES), noBlank: true, confirm: false },
          { type: 'qty', path: 'qtyHundredths', label: 'Quantity' },
          { type: 'text', path: 'unit', label: 'Unit', confirm: false, placeholder: 'hr, day, shift, item' },
          { type: 'money', path: 'rateCents', label: 'Rate (ex GST)' },
          { type: 'check', path: 'optional', label: 'Optional — the client can tick it', structural: true },
          { type: 'check', path: 'optionalDefault', label: 'Optional item starts ticked' },
        ],
        extra: quoteLineExtra,
        presets: [{ label: 'Insert prototype rates (CONFIRM)', insert: (c) => {
          const lines = L.ratePresets.lines.map((l) => ({ id: newLineId(), qtyHundredths: 100, ...l, ...(l.rateCents != null ? { unconfirmed: L.ratePresets.confirm } : {}) }));
          c.set('quote.lines', [...(c.get('quote.lines') || []), ...lines], { structural: true });
        } }] },
      { type: 'custom', render: quoteTotalsView },
      ...TERMS.map(([k, label]) => ({ type: 'text', path: `quote.terms.${k}`, label })),
      { type: 'custom', render: () => h('div', { class: 'ed-rows-tools' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => insert(ctx, { path: 'quote.terms', value: L.ratePresets.terms, id: 'prototype-terms', name: 'Quotation terms', confirm: L.ratePresets.confirm.replace('Rate', 'Terms') }) }, icon('book-open'), h('span', { text: 'Insert prototype terms (CONFIRM)' }))) },
      { type: 'lines', path: 'quote.assumptions', label: 'Assumptions' },
      { type: 'lines', path: 'quote.exclusions', label: 'Exclusions' },
    ];
    case 'attachments': return [
      { type: 'note', text: `Each document the client can open needs a PDF, up to 25 MB. Every file is checked before it can be sent: anything that can run (scripts, launch actions, embedded files) is refused. ${ctx.BRAND.name}'s own suite PDFs carry calculation scripts, so attach a flattened copy — open it and print it to PDF.` },
      { type: 'rows', path: 'attachments', label: 'Documents', addLabel: 'Add a document', newId: () => `a${Date.now().toString(36)}`, title: (r) => r.title || 'Document',
        newRow: () => ({ id: `a${Date.now().toString(36)}`, category: 'project', visibility: 'client' }),
        extra: (row, i, c, rowPath) => attachBox(c, row, rowPath),
        columns: [
          { type: 'text', path: 'title', label: 'Title', confirm: false },
          { type: 'select', path: 'category', label: 'Group', options: CATEGORIES, noBlank: true, confirm: false },
          { type: 'text', path: 'docCode', label: 'Document code', confirm: false, help: `Only a code ${ctx.BRAND.name} has allocated. Never invent one.` },
          { type: 'text', path: 'docRev', label: 'Revision', confirm: false },
          { type: 'date', path: 'docDate', label: 'Date', confirm: false },
          { type: 'select', path: 'visibility', label: 'Who sees it', options: [['client', 'The client can open it'], ['on-request', 'Listed as available on request']], noBlank: true, confirm: false },
        ] },
    ];
    case 'terms': return [
      { type: 'note', text: `${ctx.BRAND.name} has no terms and conditions yet (C3). Leave these blank and the acceptance wording leaves them out (Q7).` },
      { type: 'text', path: 'terms.version', label: 'Terms version' },
      { type: 'paras', path: 'terms.body', label: 'Terms and conditions', rows: 8 },
      { type: 'custom', render: () => h('div', {}, lockedLine(ctx, 'preliminaryStatus', 'Always shown'), lockedLine(ctx, 'misfire', 'Always shown'), lockedLine(ctx, 'emergency000', 'Always shown')) },
    ];
    case 'accept': return [
      { type: 'custom', render: () => lockedLine(ctx, 'hp1Framing', 'Acceptance means') },
      { type: 'select', path: 'accept.signature', label: 'Signature', options: [['both', 'Drawn or typed'], ['typed', 'Typed only'], ['drawn', 'Drawn only']], noBlank: true, confirm: false, help: 'Online acceptance is wired up in Phase 5.' },
    ];
    case 'contact': return [
      { type: 'note', tone: 'lock', text: 'From lib/brand.js: the principal’s card, entity, ABN and tagline. The same on every proposal.' },
    ];
    default: return [];
  }
}

/* ------------------------------------------------------- custom widgets */

function docsPicker(ctx) {
  const items = ctx.get('docs.items') || [];
  const box = h('div', { class: 'ed-field' }, h('p', { class: 'ed-label', text: 'Suite documents we will provide' }));
  for (const d of ctx.TPL.register || []) {
    const idx = items.findIndex((x) => x.id === d.id);
    const on = idx >= 0 && items[idx].provide !== false;
    const id = `doc-${d.id}`;
    const cb = h('input', { type: 'checkbox', id, class: 'ed-check', disabled: d.status !== 'approved' });
    cb.checked = on;
    cb.addEventListener('change', () => {
      const now = (ctx.get('docs.items') || []).filter((x) => x.id !== d.id);
      ctx.set('docs.items', cb.checked ? [...now, { id: d.id, provide: true }].sort((a, b) => a.id.localeCompare(b.id)) : now, { structural: true });
    });
    const row = h('div', { class: 'ed-doc' }, h('div', { class: 'ed-field--check' }, cb, h('label', { for: id }, h('strong', { text: d.id }), ` ${d.title}`, d.status !== 'approved' ? h('em', { text: ' — draft, not offered' }) : null)));
    if (on) row.append(renderField({ type: 'text', path: ['docs', 'items', idx, 'note'], label: 'Note', confirm: false }, ctx));
    box.append(row);
  }
  return box;
}

function logisticsPicker(ctx) {
  const chosen = new Set(ctx.get('logistics.commitments') || []);
  const box = h('div', { class: 'ed-field' }, h('p', { class: 'ed-label', text: 'Commitments shown' }));
  for (const [slug, field] of LOGISTICS) {
    const s = (ctx.TPL.services || []).find((x) => x.slug === slug);
    if (!s || !s[field]) continue;
    const key = `${slug}.${field}`;
    const id = `lg-${slug}-${field}`;
    const cb = h('input', { type: 'checkbox', id, class: 'ed-check' });
    cb.checked = chosen.has(key);
    cb.addEventListener('change', () => {
      const now = new Set(ctx.get('logistics.commitments') || []);
      if (cb.checked) now.add(key); else now.delete(key);
      ctx.set('logistics.commitments', now.size ? [...now] : undefined, { structural: true });
    });
    box.append(h('div', { class: 'ed-field--check ed-doc' }, cb, h('label', { for: id }, h('strong', { text: `${s.name} · ${field === 'integrate' ? 'how we work' : 'security line'}` }), h('span', { class: 'ed-hint ed-block', text: s[field] }))));
  }
  return box;
}

function competencyPicker(row, i, ctx, rowPath) {
  const person = (ctx.TPL.people || []).find((p) => p.slug === row.personId);
  if (!person) return null;
  const all = [...(person.competencies || []), ...(person.licences || [])];
  const current = Array.isArray(row.competencies) ? row.competencies : [];
  const box = h('div', { class: 'ed-field' }, h('p', { class: 'ed-label', text: 'Units of competency and licences' }),
    h('p', { class: 'ed-hint', text: 'Shown only when ticked as sighted and current. The website lists all of these as CONFIRM (C5).' }));
  all.forEach((text, k) => {
    const id = `cmp-${i}-${k}`;
    const cb = h('input', { type: 'checkbox', id, class: 'ed-check' });
    cb.checked = current.some((c) => c.text === text && c.confirmed === true);
    cb.addEventListener('change', () => {
      const next = all.map((t) => {
        const was = (ctx.get([...rowPath, 'competencies']) || []).find((c) => c.text === t);
        return { text: t, confirmed: t === text ? cb.checked : was?.confirmed === true };
      });
      ctx.set([...rowPath, 'competencies'], next);
    });
    box.append(h('div', { class: 'ed-field--check' }, cb, h('label', { for: id, text: text })));
  });
  return box;
}

function quoteLineExtra(row, i, ctx, rowPath) {
  const box = h('div', { class: 'ed-line-sum' });
  let amount = null;
  try { amount = lineAmountCents(row); } catch { /* shown as invalid */ }
  box.append(h('p', { text: amount == null ? (row.basis === 'at-cost' ? 'At cost + GST (not summed)' : 'No amount yet') : `Amount ${formatAUD(amount)} ex GST` }));
  if (row.unconfirmed) {
    box.append(h('p', { class: 'ed-confirm-note' }, icon('alert-triangle'), ` ${row.unconfirmed} `,
      h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => { const n = clone(ctx.get('quote.lines')); delete n[i].unconfirmed; ctx.set('quote.lines', n, { structural: true }); } }, `Rate confirmed with ${ctx.BRAND.name}`)));
  }
  return box;
}

function quoteTotalsView(ctx) {
  const lines = ctx.get('quote.lines') || [];
  let t = null;
  try { t = quoteTotals(lines, lines.filter((l) => l.optional && l.optionalDefault).map((l) => l.id)); } catch { /* invalid line */ }
  return h('div', { class: 'ed-totals', 'aria-live': 'polite' },
    t ? h('p', {}, h('span', { text: 'Subtotal ' }), h('strong', { text: formatAUD(t.subtotal) }), h('span', { text: ' · GST ' }), h('strong', { text: formatAUD(t.gst) }), h('span', { text: ' · Total ' }), h('strong', { text: formatAUD(t.total) }), t.unpriced ? h('span', { text: ` · plus ${t.unpriced} at cost` }) : null)
      : h('p', { class: 'ed-error', text: 'A line has an invalid quantity or rate.' }),
    h('p', { class: 'ed-hint', text: 'Optional items count here only if they start ticked. The client can change that on the page.' }));
}
