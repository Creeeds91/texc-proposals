/**
 * The editor's calls to the server. Same origin, session cookie, JSON.
 * A 401 means the session ended: the browser goes to sign in and comes back.
 * Never throws: { ok, status, json }.
 */
export async function api(method, path, payload, { raw = null, contentType = 'application/json' } = {}) {
  try {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': raw ? 'application/octet-stream' : contentType },
      body: raw || (payload === undefined ? undefined : JSON.stringify(payload)),
      cache: 'no-store',
    });
    if (r.status === 401) {
      location.assign(`/signin?next=${encodeURIComponent(location.pathname)}`);
      return { ok: false, status: 401, json: null };
    }
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { ok: r.ok, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: { error: 'No connection. Your changes are kept in this browser.' } };
  }
}
