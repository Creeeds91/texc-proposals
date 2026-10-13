/**
 * The only place this machinery spells out whose it is.
 *
 * Server code imports BRAND; scripts/build.mjs writes it into every generated
 * page as a JSON data block (never an inline script — the client page runs
 * under a strict CSP) and fills {{brand.<key>}} tokens in the templates.
 * Never type the business name, phone, email or ABN into an endpoint, a
 * template or a runtime script: add a key here. `node scripts/check.mjs brand`
 * fails the moment one is typed.
 *
 * Values are copied from texc/content/site.ts (the website, which is the
 * reference) and texc/documents/CLAUDE.md (fixed facts). Anything marked
 * CONFIRM is held back until TEXC confirms it — see docs/open-items.md.
 */
export const BRAND = Object.freeze({
  name: 'TEXC',
  legalName: 'TEXC Pty Ltd',
  abn: '47 688 368 881',
  tagline: 'The Explosive Contractor. Wherever you need one.',
  positioning: 'Shotfiring & Relief Services',
  phoneDisplay: '0467 651 182',
  phoneHref: 'tel:0467651182',
  email: 'management@texc.au',
  web: 'texc.au',
  webHref: 'https://texc.au',
  principalName: 'George Scott',
  principalRole: 'Managing Director | Licensed Shotfirer',
  signoff: 'Regards,',
  // Proposal reference prefix. CONFIRM (C9): a proposal number outside the
  // document-code taxonomy in texc/documents/register.md.
  refPrefix: 'TEXC-P',
  logoGold: '/assets/img/logo/TEXC-Gold.svg',
  logoWhite: '/assets/img/logo/TEXC-White.svg',
  logoBlack: '/assets/img/logo/TEXC-Black.svg',
  privacyHref: '/privacy/',
  // Brand colours, for email templates (which cannot read tokens.css).
  colours: Object.freeze({ ink: '#111111', gold: '#c59e42', paper: '#f4f2ec', goldOnPaper: '#7a5b17' }),
});

/** The brand as a JSON data block body. `<` is escaped so it can never close the tag. */
export function brandJson() {
  return JSON.stringify(BRAND).replace(/</g, '\\u003c');
}

/** Fill {{brand.key}} tokens. Unknown or non-string keys throw — fail closed. */
export function fillBrand(text) {
  return text.replace(/\{\{brand\.([a-zA-Z]+)\}\}/g, (_, key) => {
    const value = BRAND[key];
    if (typeof value !== 'string') throw new Error(`Unknown brand key: ${key}`);
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}
