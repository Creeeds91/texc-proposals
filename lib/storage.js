/**
 * Supabase Storage, server-side, for the three PRIVATE buckets. Nothing is ever
 * publicly readable: a browser only ever receives a short-lived signed URL.
 *
 *   texc-media         photographs uploaded in the editor
 *   texc-attachments   PDFs (Phase 4)
 *   texc-acceptances   signatures and acceptance records (Phase 5)
 */
import { db } from './db.js';

export const MEDIA_BUCKET = 'texc-media';
export const ATTACH_BUCKET = 'texc-attachments';

const auth = (d) => ({ apikey: d.key, ...(d.H.Authorization ? { Authorization: d.H.Authorization } : {}) });
// Storage paths are built by this app from checked parts; each segment is still encoded on the way out.
const enc = (path) => String(path).split('/').map(encodeURIComponent).join('/');

/** Upload bytes. Never overwrites (x-upsert false): paths are content-addressed. */
export async function upload(bucket, path, bytes, contentType) {
  const d = db();
  if (!d) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${d.base}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: { apikey: d.key, ...(d.H.Authorization ? { Authorization: d.H.Authorization } : {}), 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
      body: bytes,
    });
    // An identical file already stored at a content-addressed path is a success.
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (String(j.statusCode) === '409' || /exists/i.test(String(j.message || ''))) return { ok: true, existed: true };
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch { return { ok: false, status: 0 }; }
}

/** Signed download URLs for several paths at once. Returns { path: absoluteUrl }. */
export async function signUrls(bucket, paths, expiresIn = 3600) {
  const d = db();
  const out = {};
  if (!d || !paths.length) return out;
  try {
    const r = await fetch(`${d.base}/storage/v1/object/sign/${bucket}`, {
      method: 'POST',
      headers: { ...d.H },
      body: JSON.stringify({ expiresIn, paths }),
    });
    if (!r.ok) return out;
    for (const item of await r.json()) {
      if (item && item.signedURL && !item.error) out[item.path] = `${d.base}/storage/v1${item.signedURL}`;
    }
  } catch { /* the page falls back to no image rather than an error */ }
  return out;
}

/**
 * A one-off URL the browser uploads ONE file to, directly — a PDF can be larger
 * than a Vercel function accepts (4.5 MB). The bucket's own size and type limits
 * still apply, the path is fixed by the server, and it never overwrites.
 * Returns the absolute URL, or null.
 */
export async function signUpload(bucket, path) {
  const d = db();
  if (!d) return null;
  try {
    const r = await fetch(`${d.base}/storage/v1/object/upload/sign/${bucket}/${enc(path)}`, { method: 'POST', headers: { ...auth(d), 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j.url === 'string' && j.url.startsWith('/object/upload/sign/') ? `${d.base}/storage/v1${j.url}` : null;
  } catch { return null; }
}

/**
 * The bytes of a stored file, read with the secret key. Stops reading past
 * `maxBytes` and answers { ok: false, tooLarge: true } rather than buffering it.
 */
export async function download(bucket, path, maxBytes) {
  const d = db();
  if (!d) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${d.base}/storage/v1/object/authenticated/${bucket}/${enc(path)}`, { headers: auth(d) });
    if (!r.ok || !r.body) return { ok: false, status: r.status };
    const chunks = [];
    let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > maxBytes) return { ok: false, tooLarge: true };
      chunks.push(chunk);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch { return { ok: false, status: 0 }; }
}

export async function remove(bucket, paths) {
  const d = db();
  if (!d || !paths.length) return false;
  try {
    const r = await fetch(`${d.base}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { ...auth(d), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
    return r.ok;
  } catch { return false; }
}

/**
 * One short-lived signed URL. With `downloadName` the file arrives as a
 * download under that name; without it, it opens in the browser.
 */
export async function signUrl(bucket, path, expiresIn, { downloadName = '' } = {}) {
  const d = db();
  if (!d) return null;
  try {
    const r = await fetch(`${d.base}/storage/v1/object/sign/${bucket}/${enc(path)}`, { method: 'POST', headers: { ...d.H }, body: JSON.stringify({ expiresIn }) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.signedURL !== 'string') return null;
    return `${d.base}/storage/v1${j.signedURL}${downloadName ? `&download=${encodeURIComponent(downloadName)}` : ''}`;
  } catch { return null; }
}
