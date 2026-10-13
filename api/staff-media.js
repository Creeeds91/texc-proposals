/**
 * Photographs, staff side.
 *
 *   POST /api/staff-media?proposal=<id>&file=<u-hash>-<width>.<webp|jpg>   body: the image bytes
 *        → { ok }   stored in the private texc-media bucket, never overwritten
 *   POST /api/staff-media  { proposal, media: { id: { widths, type } } }
 *        → { media: { id: { srcset: [[w, url]] } } }   one-hour links for the editor preview
 *
 * The browser has already resized the photograph and dropped its EXIF/GPS
 * (assets/js/editor/media.js); this checks it is really an image of the kind
 * named, of a sane size, before it is stored.
 */
import { db } from '../lib/db.js';
import { body, rawBody, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole } from '../lib/accounts.js';
import { upload, signUrls, MEDIA_BUCKET } from '../lib/storage.js';
import { mediaPath, getProposal } from '../lib/proposals.js';
import { UUID_RE } from '../lib/tokens.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 20 };
const MAX_BYTES = 2_500_000;
const FILE_RE = /^(u-[a-f0-9]{16})-(\d{3,4})\.(webp|jpg)$/;

const isWebp = (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST']) || refuseCrossSite(req, res)) return;
  const d = db();
  const who = await requireRole(req, res, d, 'editor');
  if (!who) return;
  const q = req.query || {};

  if (q.file) {
    if (await rateLimited(d, req, `media-up:${who.email}`, 120, 600)) { tooMany(res); return; }
    const m = FILE_RE.exec(String(q.file));
    const pid = String(q.proposal || '');
    if (!m || !UUID_RE.test(pid) || !(await getProposal(d, pid))) { res.status(400).json({ error: 'That upload was not understood.' }); return; }
    const bytes = rawBody(req);
    const type = m[3] === 'jpg' ? 'image/jpeg' : 'image/webp';
    if (!bytes.length || bytes.length > MAX_BYTES || (type === 'image/webp' ? !isWebp(bytes) : !isJpeg(bytes))) {
      res.status(400).json({ error: 'That file is not a photograph this editor made.' });
      return;
    }
    const out = await upload(MEDIA_BUCKET, mediaPath(pid, m[1], Number(m[2]), type), bytes, type);
    if (!out.ok) { res.status(503).json({ error: 'The photograph could not be stored. Try again.' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  const b = body(req, 100_000);
  const pid = String(b.proposal || '');
  if (!UUID_RE.test(pid) || !b.media || typeof b.media !== 'object') { res.status(400).json({ error: 'Which photographs?' }); return; }
  const wanted = [];
  for (const [id, m] of Object.entries(b.media).slice(0, 60)) {
    if (!/^u-[a-f0-9]{16}$/.test(id) || !m || !Array.isArray(m.widths)) continue;
    for (const w of m.widths.slice(0, 4)) if (Number.isInteger(w) && w > 0 && w <= 4000) wanted.push([id, w, mediaPath(pid, id, w, m.type)]);
  }
  const urls = await signUrls(MEDIA_BUCKET, wanted.map((x) => x[2]), 3600);
  const media = {};
  for (const [id, w, path] of wanted) if (urls[path]) (media[id] ||= { srcset: [] }).srcset.push([w, urls[path]]);
  res.status(200).json({ media });
}
