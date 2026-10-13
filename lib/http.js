/**
 * Request and response helpers shared by every endpoint.
 *
 * Endpoints run on Vercel's Node runtime (req.query, req.body, res.status().json());
 * scripts/demo/local-app.mjs provides the same shape locally.
 */

/** The one body every client-facing refusal returns: expired, withdrawn, wrong
 *  token, never existed — indistinguishable from outside, so the API is not an
 *  oracle for which proposals exist. */
export const GONE = Object.freeze({ error: 'gone' });

export function gone(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(410).json(GONE);
}

export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

/** A parsed JSON body, capped. Anything unparseable is an empty object. */
export function body(req, maxBytes = 1_200_000) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  const text = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
  if (text.length > maxBytes) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** The raw bytes of a body (uploads). */
export function rawBody(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof b === 'string') return Buffer.from(b, 'binary');
  return Buffer.alloc(0);
}

export function parseCookies(req) {
  const out = {};
  String((req.headers || {}).cookie || '').split(/;\s*/).forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) {
      try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1)); } catch { /* malformed cookie ignored */ }
    }
  });
  return out;
}

/**
 * CSRF: a state-changing request naming a foreign origin is refused. Browsers
 * always stamp cross-site requests with Origin (and Sec-Fetch-Site), which a
 * page cannot forge; requests with no browser markings (scripts, tests) pass.
 * Compared against the request's own host, so preview deployments work.
 */
export function crossSite(req) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  const origin = String(h.origin || '').trim().toLowerCase();
  if (origin) {
    if (origin === 'null') return true;
    try { if (new URL(origin).host !== host) return true; } catch { return true; }
  }
  return String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site';
}

export function refuseCrossSite(req, res) {
  if (!crossSite(req)) return false;
  res.status(403).json({ error: 'Cross-site request refused' });
  return true;
}

/** Only the given methods; anything else is 405. true = refused. */
export function onlyMethods(req, res, methods) {
  if (methods.includes(req.method)) return false;
  res.setHeader('Allow', methods.join(', '));
  res.status(405).json({ error: 'Method not allowed' });
  return true;
}

export function clampText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Short device label for a view log — "Safari on iOS", never the full user agent. */
export function deviceFamily(ua) {
  const s = String(ua || '');
  if (!s) return '';
  const os = /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Android/i.test(s) ? 'Android'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /Windows/i.test(s) ? 'Windows' : /Linux/i.test(s) ? 'Linux' : '';
  const br = /Edg\//i.test(s) ? 'Edge' : /OPR\//i.test(s) ? 'Opera' : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari' : /Firefox\//i.test(s) ? 'Firefox' : '';
  return [br, os].filter(Boolean).join(' on ') || 'Other';
}
