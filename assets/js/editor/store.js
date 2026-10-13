/**
 * Where a draft lives: on the server (PUT /api/drafts), with a copy in this
 * browser until the server has it.
 *
 *   - autosave: 2s after typing stops, and never more than 20s after the first
 *     unsaved change, however long the typing runs
 *   - every save names the version it was based on; if a colleague saved in
 *     between, the server answers 409 and nothing is overwritten — the editor
 *     asks what to do
 *   - until a save lands, the config is also kept in localStorage, so a closed
 *     tab or a dropped connection loses nothing; it is offered back on reopen
 *   - uploaded photographs are kept in IndexedDB as already-resized blobs, for
 *     an instant preview; the server copy is what a published proposal uses
 */
import { api } from './api.js';

const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 20000;
const RETRY_MS = 10000;
const backupKey = (id) => `texc-proposals:backup:${id}`;

export function readBackup(id) {
  try { const v = JSON.parse(localStorage.getItem(backupKey(id)) || 'null'); return v && v.cfg ? v : null; } catch { return null; }
}
function writeBackup(id, cfg, baseVersion) {
  try { localStorage.setItem(backupKey(id), JSON.stringify({ cfg, baseVersion, at: new Date().toISOString() })); } catch { /* storage full: the server copy still saves */ }
}
/** The same content, whatever order its keys are in (the database stores JSON with its keys reordered). */
export function sameContent(a, b) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
export function clearBackup(id) {
  try { localStorage.removeItem(backupKey(id)); } catch { /* nothing to clear */ }
}

/**
 * serverSaver({ id, getCfg, version, onState, onConflict }) -> { touch, flush, force, dirty, version }
 * onState('dirty' | 'saving' | 'saved' | 'error' | 'conflict', detail?)
 */
export function serverSaver({ id, getCfg, version, onState, onConflict }) {
  let current = version;
  let timer = null;
  let backupTimer = null;
  let firstDirtyAt = 0;
  let lastChangeAt = 0;
  let dirty = false;
  let blocked = false;
  let inflight = null;

  const save = async (force = false) => {
    clearTimeout(timer);
    timer = null;
    // One save at a time: two callers waiting on the same save must not both
    // send the same version (the second would look like a colleague's conflict).
    while (inflight) await inflight;
    if (!dirty || (blocked && !force)) return !dirty;
    const cfg = getCfg();
    const sentAt = Date.now();
    onState('saving');
    inflight = api('PUT', '/api/drafts', { id, version: current, config: cfg, ...(force ? { force: true } : {}) });
    const r = await inflight;
    inflight = null;
    if (r.ok) {
      current = r.json.version;
      blocked = false;
      // Changes typed while this save was in the air still need saving.
      if (lastChangeAt > sentAt) { firstDirtyAt = lastChangeAt; schedule(); onState('dirty'); }
      else { dirty = false; firstDirtyAt = 0; clearTimeout(backupTimer); clearBackup(id); onState('saved', r.json.updated_at); }
      return true;
    }
    if (r.status === 409) { blocked = true; onState('conflict', r.json); onConflict(r.json); return false; }
    onState('error', r.json && r.json.error);
    if (r.status !== 413) timer = setTimeout(() => save(), RETRY_MS);
    return false;
  };
  const schedule = () => {
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstDirtyAt + MAX_WAIT_MS - Date.now()));
    timer = setTimeout(() => save(), wait);
  };
  return {
    touch() {
      lastChangeAt = Date.now();
      if (!dirty) { dirty = true; firstDirtyAt = lastChangeAt; onState('dirty'); }
      clearTimeout(backupTimer);
      // Only while something is unsaved: a copy written after the save landed would be offered back for nothing.
      backupTimer = setTimeout(() => { if (dirty) writeBackup(id, getCfg(), current); }, 400);
      if (!blocked) schedule();
    },
    flush: () => save(false),
    force: () => { dirty = true; return save(true); },
    /** Take the server's copy after a conflict. */
    adopt(v) { current = v; dirty = false; blocked = false; clearTimeout(timer); clearTimeout(backupTimer); clearBackup(id); },
    dirty: () => dirty,
    version: () => current,
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
  try {
    const db = await openDb();
    const blob = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return blob;
  } catch { return null; }
}
