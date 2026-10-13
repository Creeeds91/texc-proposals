/**
 * Content Security Policies. One place, so the client page's header in
 * vercel.json, the local server and the editor endpoint cannot drift apart —
 * `node scripts/check.mjs csp` compares vercel.json with these.
 *
 * None allows 'unsafe-inline' or 'unsafe-eval'. The editor also allows blob:
 * images: a photograph a staff member has just resized is previewed from
 * memory before it is uploaded.
 */

// Photographs and documents live in Supabase Storage, reached through
// short-lived signed links: images load from the storage host, and the
// document viewer fetches a PDF's bytes from it (the editor also uploads
// there). Wildcarded to *.supabase.co until the project exists; narrow it to
// the one project origin then (one line here, and vercel.json, which
// check.mjs csp holds equal).
export const MEDIA_ORIGIN = 'https://*.supabase.co';

const base = (img) => [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src ${img}`,
  "font-src 'self'",
  `connect-src 'self' ${MEDIA_ORIGIN}`,
  // The viewer's pdf.js runs its parser in a worker from this origin.
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

export const CLIENT_CSP = base(`'self' ${MEDIA_ORIGIN}`);
export const EDITOR_CSP = base(`'self' blob: ${MEDIA_ORIGIN}`);

/**
 * The pdf.js worker's own policy, sent with the worker script. It parses
 * untrusted PDFs, so it gets nothing it does not need: its own scripts, the
 * WebAssembly decoders shipped beside it, and fetches of its own font, colour
 * and decoder files. A browser that applies the page's policy to the worker
 * instead loses only WebAssembly, and pdf.js falls back to plain scripts.
 */
export const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'";
export const VENDOR_PREFIX = '/assets/vendor/';
