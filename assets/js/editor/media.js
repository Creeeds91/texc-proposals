/**
 * Photographs in the editor.
 *
 *  - Choose one of TEXC's own photographs (the built-in set), or upload one.
 *  - An upload is resized in the browser to the widths its slot needs (the
 *    page serves them with srcset), WebP where the browser can encode it,
 *    JPEG 0.85 otherwise. Re-encoding through a canvas also drops the file's
 *    metadata — including any GPS location a phone wrote into it, which a
 *    shotfiring proposal must never carry.
 *  - Phase 2 keeps uploads in this browser (IndexedDB). Phase 3 sends the same
 *    resized files to the private bucket by signed upload URL.
 */
import { h, icon, nextId } from './dom.js';
import { putBlob, getBlob } from './store.js';

export const SLOTS = Object.freeze({
  cover: { widths: [800, 1400, 2000], label: 'Cover' },
  photo: { widths: [800, 1400], label: 'Photograph' },
  portrait: { widths: [600, 1200], label: 'Portrait' },
  plan: { widths: [1000, 2000], label: 'Site plan' },
});
const MAX_BYTES = 30 * 1024 * 1024;

async function encode(canvas) {
  const as = (type, q) => new Promise((done) => canvas.toBlob(done, type, q));
  const webp = await as('image/webp', 0.82);
  if (webp && webp.type === 'image/webp') return webp;
  return as('image/jpeg', 0.85);
}

export async function processUpload(file, slotName) {
  if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
  if (file.size > MAX_BYTES) throw new Error('That image is over 30 MB.');
  const slot = SLOTS[slotName] || SLOTS.photo;
  const buf = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const id = 'u-' + [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const bmp = await createImageBitmap(new Blob([buf], { type: file.type }), { imageOrientation: 'from-image' });
  const top = slot.widths[slot.widths.length - 1];
  const widths = [...new Set([...slot.widths.filter((w) => w < bmp.width), Math.min(bmp.width, top)])].sort((a, b) => a - b);
  let type = 'image/jpeg';
  for (const w of widths) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.round((bmp.height * w) / bmp.width);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await encode(canvas);
    type = blob.type;
    await putBlob(`${id}-${w}`, blob);
  }
  bmp.close();
  return { id, media: { local: true, widths, type, name: file.name.replace(/[^\w.\- ]+/g, '').slice(0, 80) } };
}

/* A preview copy of the config whose local photographs point at blob: URLs. */
const urlCache = new Map();
export async function previewMedia(cfg) {
  const media = cfg.media || {};
  const out = {};
  for (const [id, m] of Object.entries(media)) {
    if (!m || !m.local) { out[id] = m; continue; }
    const srcset = [];
    for (const w of m.widths || []) {
      const key = `${id}-${w}`;
      if (!urlCache.has(key)) {
        const blob = await getBlob(key);
        if (blob) urlCache.set(key, URL.createObjectURL(blob));
      }
      if (urlCache.has(key)) srcset.push([w, urlCache.get(key)]);
    }
    if (srcset.length) out[id] = { srcset };
  }
  return { ...cfg, media: out };
}

export function thumbFor(id, cfg, TPL) {
  const m = (cfg.media && cfg.media[id]) || null;
  if (m && m.local) {
    const w = (m.widths || [])[0];
    return urlCache.get(`${id}-${w}`) || '';
  }
  const p = TPL.photos && TPL.photos[id];
  return p ? p.path.replace('{w}', p.widths[0]) : '';
}

/**
 * The picker: TEXC's photographs, or an upload. Resolves to { id, media? } or null.
 */
export function pickImage({ TPL, brand, slot, title }) {
  return new Promise((resolve) => {
    const status = h('p', { class: 'ed-hint', role: 'status', 'aria-live': 'polite' });
    const fileId = nextId('file');
    const close = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    const grid = h('div', { class: 'ed-photos' },
      Object.entries(TPL.photos || {}).map(([id, p]) => h('button', {
        type: 'button', class: 'ed-photo', onclick: () => close({ id }),
        'aria-label': `Use ${id.replace(/-/g, ' ')}`,
      }, h('img', { src: p.path.replace('{w}', p.widths[0]), alt: '', loading: 'lazy' }), h('span', { text: id.replace(/-/g, ' ') }))));
    const input = h('input', { id: fileId, type: 'file', accept: 'image/*', class: 'ed-file' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      status.textContent = 'Resizing…';
      try { close(await processUpload(file, slot)); }
      catch (e) { status.textContent = e.message || 'That image could not be read.'; }
    });
    const dlg = h('dialog', { class: 'ed-dialog', 'aria-label': title || 'Choose a photograph' },
      h('div', { class: 'ed-dialog-head' },
        h('h2', { text: title || 'Choose a photograph' }),
        h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => close(null) }, icon('x'))),
      h('p', { class: 'ed-hint', text: `${brand}’s own photography only. A photograph of a site is real project imagery and must be captioned as what it is.` }),
      h('div', { class: 'ed-upload' },
        h('label', { for: fileId, class: 'btn btn--secondary btn--sm' }, icon('upload'), h('span', { text: 'Upload a photograph' })),
        input, status),
      h('p', { class: 'ed-label', text: `${brand}’s photographs` }),
      grid);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
