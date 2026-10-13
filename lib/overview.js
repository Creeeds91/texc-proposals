/**
 * The dashboard's reads, shared by api/analytics.js and api/export.js.
 * Counting is the database's (texc_overview); meaning is
 * assets/js/lifecycle.js's.
 */
import { rpc } from './db.js';
import { templateData } from './template-data.js';

/** One row per proposal, archived included. null when it could not be read. */
export async function overview(d) {
  const r = await rpc(d, 'texc_overview', { p: { archived: true } });
  return r.ok && Array.isArray(r.json) ? r.json : null;
}

/** Ids of proposals whose words start with the words given. null when search failed. */
export async function search(d, q) {
  const r = await rpc(d, 'texc_search', { p_q: String(q || '').slice(0, 200) });
  return r.ok && Array.isArray(r.json) ? r.json : null;
}

export const serviceNames = () => Object.fromEntries(templateData().services.map((s) => [s.slug, s.name]));
