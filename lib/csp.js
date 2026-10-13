/**
 * Content Security Policies. One place, so the client page's header in
 * vercel.json, the local server and (Phase 3) the editor endpoint cannot drift
 * apart — `node scripts/check.mjs csp` compares vercel.json with CLIENT_CSP.
 *
 * Neither allows 'unsafe-inline' or 'unsafe-eval'. The editor also allows
 * blob: images: a photograph a staff member has just resized is previewed
 * from memory before it is uploaded.
 */
const base = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
];

// Photographs uploaded to a proposal are served from Supabase Storage through
// one-hour signed links, so images may come from the project's storage host.
// Wildcarded to *.supabase.co until the project exists; narrow it to the one
// project origin then (one line here, and vercel.json, which check.mjs csp
// holds equal to CLIENT_CSP).
export const MEDIA_ORIGIN = 'https://*.supabase.co';

export const CLIENT_CSP = [...base.slice(0, 3), `img-src 'self' ${MEDIA_ORIGIN}`, ...base.slice(3), 'upgrade-insecure-requests'].join('; ');
export const EDITOR_CSP = [...base.slice(0, 3), `img-src 'self' blob: ${MEDIA_ORIGIN}`, ...base.slice(3), 'upgrade-insecure-requests'].join('; ');
