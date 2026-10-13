/**
 * Acceptance wording and rules, shared by the page (assets/js/proposal.js) and
 * the server (lib/acceptances.js), so the sentences a client ticks are the
 * sentences stored in their acceptance record, word for word.
 */

/** The acceptance sentence. It adapts while no terms exist rather than citing a version that is not there (Q7). */
export function acceptClause(terms) {
  const t = terms && typeof terms === 'object' ? terms : {};
  const version = typeof t.version === 'string' ? t.version.trim() : '';
  const hasBody = Array.isArray(t.body) ? t.body.some((p) => typeof p === 'string' && p.trim()) : typeof t.body === 'string' && t.body.trim() !== '';
  return version && hasBody
    ? `I accept the quotation, terms (version ${version}) and preliminary risk assessment.`
    : 'I accept the quotation and preliminary risk assessment.';
}

/** The terms version the client accepts, or null while the proposal carries no terms. */
export const termsVersionOf = (terms) => (acceptClause(terms).includes('terms (version') ? terms.version.trim() : null);

export function authorityClause(company) {
  const c = typeof company === 'string' && company.trim() ? company.trim() : 'the company';
  return `I have authority to accept on behalf of ${c}.`;
}

/**
 * How a proposal may be signed (accept.signature): 'both' = drawn or typed,
 * either is enough; 'typed' or 'drawn' = only that one.
 */
export function signatureMode(accept) {
  const m = accept && accept.signature;
  return m === 'typed' || m === 'drawn' ? m : 'both';
}

/** A typed signature is the signer's full name, as typed above it (case and spacing aside). */
export const sameName = (a, b) => {
  const n = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) !== '' && n(a) === n(b);
};

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const LIMITS = Object.freeze({ name: 120, position: 120, company: 200, email: 200, message: 2000 });

/** The next hold point after acceptance, as the revision itself words it — never invented. */
export function nextHoldPoint(cfg) {
  const list = cfg && cfg.risk && Array.isArray(cfg.risk.holdPoints) ? cfg.risk.holdPoints : [];
  const hp = list.find((h) => h && /^HP2$/i.test(String(h.code || '').trim()));
  return hp && typeof hp.title === 'string' ? { code: 'HP2', title: hp.title, requirement: typeof hp.requirement === 'string' ? hp.requirement : '' } : null;
}
