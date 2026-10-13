/**
 * The database, through Supabase's REST API (PostgREST) with the secret key.
 * Server-side only; the browser never talks to Supabase directly.
 *
 * Keys: Supabase's new secret key (`sb_secret_…`) is sent in the `apikey`
 * header ONLY — the platform rejects one presented as `Authorization: Bearer`
 * ("Invalid JWT"). A legacy service_role JWT is also sent as the bearer.
 * scripts/lib/local-supabase.mjs enforces the same rule locally.
 *
 * Errors never reach a caller verbatim (CLAUDE.md conventions): rest() returns
 * the status and parsed body for the endpoint to interpret.
 */
export function db() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SECRET_KEY || '');
  if (!base || !key) return null;
  const H = { apikey: key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(key)) H.Authorization = `Bearer ${key}`;
  return { base, key, H };
}

/**
 * One REST call. path is relative to /rest/v1/ and already encoded.
 * Returns { ok, status, json }; a network failure is { ok: false, status: 0 }.
 */
export async function rest(d, method, path, payload, { prefer = 'return=representation', headers = {} } = {}) {
  if (!d) return { ok: false, status: 0, json: null };
  try {
    const r = await fetch(`${d.base}/rest/v1/${path}`, {
      method,
      headers: { ...d.H, Prefer: prefer, ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: r.ok, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

export const rpc = (d, fn, args) => rest(d, 'POST', `rpc/${fn}`, args);

/** First row of a GET, or null on any failure — callers treat null as "not found". */
export async function one(d, path) {
  const r = await rest(d, 'GET', path);
  return r.ok && Array.isArray(r.json) ? r.json[0] || null : null;
}

export const enc = encodeURIComponent;
