/**
 * The document viewer: a PDF shown page by page in a modal, by pdf.js —
 * self-hosted and pinned (assets/vendor/pdfjs/), and loaded only when someone
 * first opens a document, so it costs the proposal page nothing.
 *
 *   openViewer({ title, meta, link, onError })
 *     link({ download }) → Promise<{ url, name, bytes }>   a fresh short-lived link
 *
 * The bytes are fetched once, in full, from a 60-second link and handed to
 * pdf.js from memory: no range requests that could outlive the link on a slow
 * connection. A PDF's own scripts never run here — pdf.js does not run them,
 * and isEvalSupported:false keeps font programs from being compiled into code
 * (the page's CSP forbids it anyway).
 *
 * A canvas cannot be read by a screen reader, so "Open in a new tab" and
 * "Download" are always offered: they are the accessible route, and the route
 * wherever pdf.js cannot run.
 */
const PDFJS = '/assets/vendor/pdfjs/5.4.624/';
const D = document;

let lib = null;
function pdfjs() {
  if (!lib) {
    lib = import(`${PDFJS}pdf.min.js`).then((m) => { m.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`; return m; });
    lib.catch(() => { lib = null; });
  }
  return lib;
}

function el(tag, cls, text) {
  const n = D.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name) {
  const svg = D.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = D.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}
const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** The whole file, with progress. */
async function fetchBytes(url, onProgress, signal) {
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Save bytes under a name without leaving the page (a same-origin blob honours `download`). */
export function saveBytes(bytes, name) {
  const href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = el('a');
  a.href = href;
  a.download = name || 'document.pdf';
  a.rel = 'noopener';
  D.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

/** Download a document by its link, staying on the page whatever happens. Throws on failure. */
export async function downloadVia(link) {
  const got = await link({ download: true });
  const bytes = await fetchBytes(got.url, () => {});
  saveBytes(bytes, got.name);
}

/**
 * Open a document in a new tab. The tab is opened at once — inside the click,
 * where browsers allow it — and pointed at the file when its link arrives.
 */
export async function openInTab(link) {
  const w = window.open('', '_blank');
  try {
    const got = await link({ download: false });
    if (!w) { location.assign(got.url); return; }
    w.opener = null;
    w.location.replace(got.url);
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

let current = null;

export function openViewer({ title, meta, link, onError }) {
  if (current) current.close();
  const opener = D.activeElement;
  const ctrl = new AbortController();
  const dlg = el('dialog', 'viewer');
  dlg.setAttribute('aria-labelledby', 'viewer-title');
  const head = el('div', 'viewer-head');
  const h = el('h2', 'viewer-title', title || 'Document');
  h.id = 'viewer-title';
  head.append(el('p', 'viewer-kicker', 'Document'), h);
  if (meta) head.append(el('p', 'viewer-meta', meta));
  const tools = el('div', 'viewer-tools');
  const btn = (cls, label, ico, onClick, aria) => {
    const b = el('button', cls);
    b.type = 'button';
    if (ico) b.append(icon(ico));
    if (label) b.append(el('span', null, label));
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  };
  const status = el('div', 'viewer-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const fail = (text) => {
    status.hidden = false;
    status.dataset.tone = 'error';
    status.replaceChildren(el('p', 'viewer-status-text', text));
    if (onError) onError(text);
  };
  const busy = (b, on) => { b.disabled = on; b.setAttribute('aria-busy', on ? 'true' : 'false'); };
  const openBtn = btn('btn btn--secondary btn--sm', 'Open in new tab', 'external-link', async () => {
    busy(openBtn, true);
    try { await openInTab(link); } catch (e) { fail((e && e.userMessage) || 'The document could not be opened in a new tab. Try again, or use Download.'); }
    busy(openBtn, false);
  });
  const dlBtn = btn('btn btn--secondary btn--sm', 'Download', 'download', async () => {
    busy(dlBtn, true);
    try { await downloadVia(link); } catch (e) { fail((e && e.userMessage) || 'The download did not complete. Try again.'); }
    busy(dlBtn, false);
  });
  const closeBtn = btn('viewer-close', null, 'x', () => close(), 'Close the document');
  tools.append(openBtn, dlBtn, closeBtn);
  const bar = el('div', 'viewer-bar');
  bar.append(head, tools);
  const body = el('div', 'viewer-body');
  body.tabIndex = 0;
  body.setAttribute('aria-label', `${title || 'Document'}, page by page`);
  const pages = el('div', 'viewer-pages');
  const progress = el('progress', 'viewer-progress');
  progress.max = 1;
  progress.value = 0;
  status.append(el('p', 'viewer-status-text', 'Loading the document…'), progress);
  body.append(status, pages);
  dlg.append(bar, body);
  D.body.append(dlg);
  D.documentElement.classList.add('viewer-open');

  let doc = null;
  let observer = null;
  const close = () => {
    if (!dlg.isConnected) return;
    ctrl.abort();
    if (observer) observer.disconnect();
    if (doc) doc.destroy().catch(() => {});
    if (dlg.open) dlg.close();
    dlg.remove();
    D.documentElement.classList.remove('viewer-open');
    if (current && current.dlg === dlg) current = null;
    if (opener && opener.focus) opener.focus();
  };
  dlg.addEventListener('close', close);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  current = { dlg, close };
  dlg.showModal();
  closeBtn.focus();

  (async () => {
    let bytes;
    try {
      const [m, got] = await Promise.all([pdfjs(), link({ download: false })]);
      bytes = await fetchBytes(got.url, (n, total) => {
        if (total) { progress.value = n / total; status.firstChild.textContent = `Loading the document… ${mb(n)} of ${mb(total)}`; }
      }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      doc = await m.getDocument({
        data: bytes, isEvalSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true,
        cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/`, iccUrl: `${PDFJS}iccs/`,
      }).promise;
    } catch (e) {
      if (!ctrl.signal.aborted) fail((e && e.userMessage) || 'This document could not be shown here. Use Open in new tab or Download.');
      return;
    }
    if (ctrl.signal.aborted) { doc.destroy().catch(() => {}); return; }
    status.hidden = true;
    const n = doc.numPages;
    if (meta) head.querySelector('.viewer-meta').textContent = meta;
    const first = await doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const slots = [];
    for (let i = 1; i <= n; i += 1) {
      const fig = el('figure', 'viewer-page');
      const canvas = el('canvas', 'viewer-canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${i} of ${n}`);
      // Until a page is drawn, its canvas holds the page's shape (CSS sizes it), not its pixels.
      canvas.width = Math.round(base.width / 4);
      canvas.height = Math.round(base.height / 4);
      fig.append(canvas, el('figcaption', 'viewer-pageno', `${i} / ${n}`));
      fig.dataset.page = String(i);
      pages.append(fig);
      slots.push({ fig, canvas, drawn: false, task: null });
    }
    const draw = async (slot, i) => {
      if (slot.drawn || slot.task) return;
      slot.drawn = true;
      try {
        const page = i === 1 ? first : await doc.getPage(i);
        const unscaled = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = Math.min(pages.clientWidth || 800, 1000);
        const viewport = page.getViewport({ scale: (cssWidth / unscaled.width) * ratio });
        const canvas = el('canvas', 'viewer-canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${i} of ${n}`);
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        slot.task = page.render({ canvas, viewport });
        await slot.task.promise;
        slot.task = null;
        if (!slot.drawn) return; // released while drawing
        slot.canvas.replaceWith(canvas);
        slot.canvas = canvas;
        slot.fig.dataset.drawn = '1';
      } catch {
        slot.task = null;
        slot.drawn = false;
      }
    };
    // Pages are drawn as they come near the screen and let go when they are far
    // away, so a long document does not exhaust a phone's canvas memory.
    const release = (slot) => {
      if (slot.task) { slot.task.cancel(); slot.task = null; }
      if (!slot.drawn) return;
      slot.drawn = false;
      slot.canvas.width = Math.round(base.width / 4);
      slot.canvas.height = Math.round(base.height / 4);
      delete slot.fig.dataset.drawn;
    };
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.page);
        if (e.isIntersecting) draw(slots[i - 1], i);
        else release(slots[i - 1]);
      }
    }, { root: body, rootMargin: '150% 0px' });
    for (const s of slots) observer.observe(s.fig);
    dlg.dataset.ready = '1';
  })();

  return { close };
}
