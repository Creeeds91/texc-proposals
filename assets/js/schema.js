/**
 * The proposal's sections — one list, shared by the client runtime, the
 * editor, the publish checks and (Phase 3) the server, so a section cannot be
 * pinned in one place and movable in another.
 *
 *   id        the data-sec value in templates/proposal.html
 *   label     what staff and the section index call it
 *   keys      top-level config keys whose content belongs to this section
 *   pinned    'first' | 'last' — cannot be moved (and the cover cannot be hidden)
 *   off       hidden unless a proposal switches it on
 */
export const SECTIONS = Object.freeze([
  { id: 'cover', label: 'Cover', keys: ['meta', 'client', 'cover'], pinned: 'first' },
  { id: 'letter', label: 'Covering letter', keys: ['letter'] },
  { id: 'glance', label: 'Proposal at a glance', keys: ['glance'] },
  { id: 'about', label: 'About', keys: ['about'] },
  { id: 'understanding', label: 'Project understanding', keys: ['understanding'] },
  { id: 'scope', label: 'Scope of works', keys: ['scope'] },
  { id: 'site', label: 'Site details and constraints', keys: ['site'] },
  { id: 'method', label: 'Proposed work process', keys: ['method'] },
  { id: 'params', label: 'Preliminary blast parameters', keys: ['params'], off: true },
  { id: 'env', label: 'Vibration, overpressure and environment', keys: ['env'] },
  { id: 'risk', label: 'Safety, risk and compliance', keys: ['risk'] },
  { id: 'docs', label: 'Documentation we will provide', keys: ['docs'] },
  { id: 'logistics', label: 'Explosives logistics and security', keys: ['logistics'], off: true },
  { id: 'team', label: 'Personnel and competencies', keys: ['team'] },
  { id: 'programme', label: 'Programme and mobilisation', keys: ['programme'] },
  { id: 'quote', label: 'Quotation', keys: ['quote'] },
  { id: 'attachments', label: 'Documents and attachments', keys: ['attachments'] },
  { id: 'terms', label: 'Terms and disclaimers', keys: ['terms'] },
  { id: 'accept', label: 'Acceptance', keys: ['accept'], pinned: 'last' },
  { id: 'contact', label: 'Contact', keys: ['contact'], pinned: 'last' },
]);

export const PINNED_FIRST = SECTIONS.filter((s) => s.pinned === 'first').map((s) => s.id);
export const PINNED_LAST = SECTIONS.filter((s) => s.pinned === 'last').map((s) => s.id);
export const DEFAULT_OFF = new Set(SECTIONS.filter((s) => s.off).map((s) => s.id));
export const SECTION_OF_KEY = Object.freeze(Object.fromEntries(SECTIONS.flatMap((s) => s.keys.map((k) => [k, s.id]))));

/** The visible sections of a config, in order (same rules as the runtime). */
export function visibleSections(cfg) {
  const configured = Array.isArray(cfg?.layout?.sections) ? cfg.layout.sections : [];
  const on = new Map(SECTIONS.map((s) => [s.id, !s.off]));
  for (const s of configured) if (on.has(s.id)) on.set(s.id, s.on !== false);
  const middle = configured.map((s) => s.id).filter((id) => on.has(id) && !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id));
  const rest = SECTIONS.map((s) => s.id).filter((id) => !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id) && !middle.includes(id));
  return [...PINNED_FIRST, ...middle, ...rest, ...PINNED_LAST].filter((id) => on.get(id) || id === 'cover');
}

export const DOC_TYPES = Object.freeze({
  shotfiring: 'Shotfiring Proposal',
  preliminary: 'Preliminary Proposal',
  variation: 'Variation',
  'relief-cover': 'Relief Cover Proposal',
});

// TEXC's own status wording where it has one — never paraphrased.
export const STATUS = Object.freeze({
  draft: 'Draft',
  preliminary: 'Preliminary - For Review',
  issued: 'Issued',
  accepted: 'Accepted',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
});

export const isConfirm = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && '$confirm' in v;
