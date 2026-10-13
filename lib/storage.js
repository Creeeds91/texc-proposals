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
