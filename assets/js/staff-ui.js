/**
 * What the staff pages share (the dashboard, the Documents page): building
 * elements without ever writing data as HTML, icons from the sprite, and one
 * way to call the API that sends a signed-out person to sign in and back.
 */
const D = document;
const SVG = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...children) {
  const el = D.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : D.createTextNode(String(c)));
  }
  return el;
}

export function s(tag, attrs = {}, ...children) {
  const el = D.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c instanceof Node ? c : D.createTextNode(String(c)));
  return el;
}

export function icon(name, cls = 'ic') {
  return s('svg', { class: cls, 'aria-hidden': 'true' }, s('use', { href: `/assets/img/icons.svg#${name}` }));
}

/** The API, from a page that `back` names: a signed-out person goes to sign in and returns there. */
export function apiFor(back) {
  return async function api(method, path, payload) {
    try {
      const r = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (r.status === 401) { location.assign(`/signin?next=${encodeURIComponent(back)}`); return { ok: false, status: 401, json: null }; }
      let json = null;
      try { json = await r.json(); } catch { json = null; }
      return { ok: r.ok, status: r.status, json };
    } catch {
      return { ok: false, status: 0, json: { error: 'No connection. Try again.' } };
    }
  };
}
