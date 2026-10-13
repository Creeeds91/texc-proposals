/** Small DOM and path helpers for the editor. No framework, no innerHTML from data. */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

let uid = 0;
export const nextId = (prefix = 'ed') => `${prefix}-${(uid += 1)}`;

/** 'a.b.0.c' or ['a','b',0,'c'] -> array of keys. */
export function toPath(path) {
  if (Array.isArray(path)) return path;
  return String(path).split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k));
}

export function getIn(obj, path) {
  return toPath(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setIn(obj, path, value) {
  const keys = toPath(path);
  let o = obj;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      if (value === undefined) { if (Array.isArray(o)) o.splice(k, 1); else delete o[k]; }
      else o[k] = value;
      return;
    }
    if (o[k] == null || typeof o[k] !== 'object') o[k] = typeof keys[i + 1] === 'number' ? [] : {};
    o = o[k];
  });
  return obj;
}

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const isConfirmValue = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && '$confirm' in v;

/** Replace {client} and {site} tokens in library text with this proposal's values. */
export function fillTokens(value, cfg) {
  const company = String(cfg?.client?.company || '').trim();
  const client = company.replace(/\s+Pty\.?\s+Ltd\.?$/i, '').replace(/\s+Limited$/i, '') || '{client}';
  const site = String(cfg?.meta?.siteLocality || '').trim() || '{site}';
  const fill = (s) => s.replace(/\{client\}/g, client).replace(/\{site\}/g, site);
  if (typeof value === 'string') return fill(value);
  if (Array.isArray(value)) return value.map((v) => fillTokens(v, cfg));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTokens(v, cfg)]));
  return value;
}

export function announce(text) {
  const live = document.getElementById('ed-live');
  if (live) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); }
}
