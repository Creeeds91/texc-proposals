/**
 * Where a draft lives in Phase 2: this browser only.
 *
 *   - the config in localStorage, autosaved: 2s after typing stops, and never
 *     more than 20s after the first unsaved change, however long the typing runs
 *   - uploaded photographs in IndexedDB, as already-resized blobs
 *
 * Phase 3 replaces both with the server (PUT /api/drafts with a version check,
 * signed uploads to the private bucket). The interface here is what the editor
 * calls, so that swap touches this file only.
 */

const DRAFT_KEY = 'texc-proposals:draft';
const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 20000;

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.cfg ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDraft(cfg) {
  const savedAt = new Date().toISOString();
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ cfg, savedAt }));
  return savedAt;
}

export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}

/**
 * autosave(getCfg, onState) -> { touch(), flush(), dirty() }
 * onState('saving' | 'saved' | 'error' | 'dirty', isoTime?)
 */
export function autosaver(getCfg, onState) {
  let timer = null;
  let firstDirtyAt = 0;
  let dirty = false;
  const save = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    onState('saving');
    try {
      const at = writeDraft(getCfg());
      dirty = false;
      firstDirtyAt = 0;
      onState('saved', at);
    } catch {
      onState('error');
    }
  };
  return {
    touch() {
      const now = Date.now();
      if (!dirty) { dirty = true; firstDirtyAt = now; onState('dirty'); }
      clearTimeout(timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstDirtyAt + MAX_WAIT_MS - now));
      timer = setTimeout(save, wait);
    },
    flush: save,
    dirty: () => dirty,
  };
}

/* ------------------------------------------------------------ photographs */

const DB = 'texc-proposals-media';
const STORE = 'blobs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlob(key, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getBlob(key) {
  const db = await openDb();
  const blob = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}
