/**
 * Editor fields. Each one is bound to a config path and writes through
 * ctx.set(path, value). Typing never re-renders the drawer (focus stays put);
 * adding, moving or removing rows does.
 *
 * Any text field can be flagged "Needs confirming": its value becomes
 * {"$confirm": "<what>"}, the preview shows a red CONFIRM tag, and the
 * checklist will not let it be published while its section is on.
 */
import { h, icon, nextId, toPath, isConfirmValue } from './dom.js';
import { pickImage, thumbFor } from './media.js';

const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/* -------------------------------------------------------------- parsing */

export function parseMoney(text) {
  const t = String(text).replace(/[$,\s]/g, '');
  if (!t) return null;
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}
export const showMoney = (cents) => (Number.isSafeInteger(cents) ? `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : '');

export function parseQty(text) {
  const t = String(text).replace(/[,\s]/g, '');
  if (!t) return null;
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}
export const showQty = (h100) => {
  if (!Number.isSafeInteger(h100)) return '';
  const frac = h100 % 100;
  return frac ? `${Math.floor(h100 / 100)}.${String(frac).padStart(2, '0').replace(/0$/, '')}` : String(h100 / 100);
};

/* ------------------------------------------------------------ the frame */

function frame(spec, id, control, ctx, path) {
  const value = ctx.get(path);
  const wrap = h('div', { class: 'ed-field', dataset: { path: toPath(path).join('.') } });
  if (isConfirmValue(value)) wrap.classList.add('is-confirm');
  const label = h('label', { class: 'ed-label', for: id }, h('span', {}, spec.label, spec.required ? h('span', { class: 'ed-req', title: 'Required', text: ' *' }) : null));
  const head = h('div', { class: 'ed-field-head' }, label);
  if (spec.confirm !== false && ['text', 'area', 'paras', 'lines', 'date', 'select'].includes(spec.type)) {
    const btn = h('button', {
      type: 'button', class: 'ed-flag', 'aria-pressed': isConfirmValue(value) ? 'true' : 'false',
      title: `Mark as needing confirmation from ${ctx.BRAND.name}`,
    }, isConfirmValue(value) ? 'Needs confirming' : 'Mark CONFIRM');
    btn.addEventListener('click', () => {
      const now = ctx.get(path);
      if (isConfirmValue(now)) { ctx.set(path, now.suggested ?? undefined, { structural: true }); return; }
      // Whatever was typed is kept as the suggestion, so flagging never loses work.
      const kept = Array.isArray(now) ? (now.length ? now : undefined) : (typeof now === 'string' && now.trim() ? now : undefined);
      ctx.set(path, { $confirm: `${spec.label}: needs confirming by ${ctx.BRAND.name}`, ...(kept !== undefined ? { suggested: kept } : {}) }, { structural: true });
    });
    head.append(btn);
  }
  wrap.append(head, control);
  if (isConfirmValue(value)) {
    wrap.append(h('p', { class: 'ed-confirm-note' }, icon('alert-triangle'), h('span', { text: `CONFIRM: ${str(value.$confirm)}` })));
    if (value.suggested != null) {
      const shown = Array.isArray(value.suggested) ? value.suggested.join(spec.type === 'paras' ? '\n\n' : '\n') : str(value.suggested);
      wrap.append(h('p', { class: 'ed-suggested', text: shown }),
        h('button', { type: 'button', class: 'ed-linkbtn ed-block', onclick: () => ctx.set(path, value.suggested, { structural: true }) }, 'Confirmed — use this text'));
    }
  }
  if (spec.help) wrap.append(h('p', { class: 'ed-hint', id: `${id}-hint`, text: spec.help }));
  if (spec.help) control.setAttribute?.('aria-describedby', `${id}-hint`);
  return wrap;
}

/* -------------------------------------------------------------- widgets */

function textLike(spec, ctx, path) {
  const id = nextId();
  const value = ctx.get(path);
  const conf = isConfirmValue(value);
  let el;
  if (spec.type === 'area' || spec.type === 'paras' || spec.type === 'lines') {
    el = h('textarea', { id, class: 'ed-input ed-area', rows: spec.rows || (spec.type === 'lines' ? 4 : 5) });
    const v = conf ? '' : spec.type === 'paras' ? (Array.isArray(value) ? value.join('\n\n') : str(value))
      : spec.type === 'lines' ? (Array.isArray(value) ? value.join('\n') : str(value)) : str(value);
    el.value = v;
  } else {
    el = h('input', { id, class: 'ed-input', type: spec.type === 'date' ? 'date' : spec.type === 'email' ? 'email' : 'text', autocomplete: 'off' });
    el.value = conf ? '' : str(value);
    if (spec.readonly) { el.readOnly = true; el.classList.add('is-readonly'); }
  }
  if (spec.placeholder) el.placeholder = spec.placeholder;
  if (conf) el.placeholder = `CONFIRM — ${str(value.$confirm)}`;
  let wrap = null;
  el.addEventListener('input', () => {
    let v = el.value;
    if (spec.type === 'paras') v = v.split(/\n\s*\n/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    else if (spec.type === 'lines') v = v.split('\n').map((s) => s.trim()).filter(Boolean);
    if ((Array.isArray(v) && !v.length) || v === '') v = undefined;
    ctx.set(path, v);
    // Typing over a CONFIRM clears it in place, without redrawing (and losing the cursor).
    if (wrap && wrap.classList.contains('is-confirm')) {
      wrap.classList.remove('is-confirm');
      wrap.querySelector('.ed-confirm-note')?.remove();
      const flag = wrap.querySelector('.ed-flag');
      if (flag) { flag.textContent = 'Mark CONFIRM'; flag.setAttribute('aria-pressed', 'false'); }
      el.placeholder = spec.placeholder || '';
    }
  });
  wrap = frame(spec, id, el, ctx, path);
  if (spec.type === 'paras') wrap.append(h('p', { class: 'ed-hint', text: 'A blank line starts a new paragraph. **Double asterisks** make text bold.' }));
  if (spec.type === 'lines') wrap.append(h('p', { class: 'ed-hint', text: 'One item per line.' }));
  return wrap;
}

function select(spec, ctx, path) {
  const id = nextId();
  const value = ctx.get(path);
  const el = h('select', { id, class: 'ed-input' });
  const options = typeof spec.options === 'function' ? spec.options(ctx) : spec.options;
  if (!spec.noBlank) el.append(h('option', { value: '', text: spec.blank || '—' }));
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  el.value = isConfirmValue(value) ? '' : str(value);
  el.addEventListener('change', () => ctx.set(path, el.value === '' ? undefined : el.value, { structural: !!spec.structural || isConfirmValue(ctx.get(path)) }));
  return frame(spec, id, el, ctx, path);
}

function check(spec, ctx, path) {
  const id = nextId();
  const el = h('input', { id, type: 'checkbox', class: 'ed-check' });
  el.checked = ctx.get(path) === true;
  el.addEventListener('change', () => ctx.set(path, el.checked ? true : undefined, { structural: !!spec.structural }));
  const row = h('div', { class: 'ed-field ed-field--check' }, el, h('label', { for: id, text: spec.label }));
  if (spec.help) row.append(h('p', { class: 'ed-hint', text: spec.help }));
  return row;
}

function numberLike(spec, ctx, path) {
  const id = nextId();
  const money = spec.type === 'money';
  const value = ctx.get(path);
  const el = h('input', { id, class: 'ed-input ed-numeric', inputmode: 'decimal', autocomplete: 'off', placeholder: money ? '0.00' : '0' });
  el.value = money ? showMoney(value) : showQty(value);
  const err = h('p', { class: 'ed-error', role: 'alert' });
  el.addEventListener('input', () => {
    const parsed = money ? parseMoney(el.value) : parseQty(el.value);
    if (parsed === undefined) { err.textContent = money ? 'Dollars and cents, e.g. 150.00' : 'A number with up to two decimals'; el.setAttribute('aria-invalid', 'true'); return; }
    err.textContent = '';
    el.removeAttribute('aria-invalid');
    ctx.set(path, parsed === null ? (money ? null : undefined) : parsed);
  });
  const wrap = frame(spec, id, money ? h('div', { class: 'ed-money' }, h('span', { text: '$' }), el) : el, ctx, path);
  wrap.append(err);
  return wrap;
}

function image(spec, ctx, path) {
  const id = nextId();
  const ref = ctx.get(path);
  const has = ref && typeof ref === 'object' && ref.id;
  const wrap = h('div', { class: 'ed-field ed-image', dataset: { path: toPath(path).join('.') } });
  wrap.append(h('p', { class: 'ed-label' }, h('span', {}, spec.label, spec.required ? h('span', { class: 'ed-req', text: ' *' }) : null)));
  const thumb = has ? thumbFor(ref.id, ctx.cfg(), ctx.TPL) : '';
  wrap.append(h('div', { class: 'ed-image-row' },
    h('div', { class: 'ed-thumb' }, thumb ? h('img', { src: thumb, alt: '' }) : h('span', { text: has ? ref.id : 'No photograph' })),
    h('div', { class: 'ed-image-actions' },
      h('button', {
        type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
          const picked = await pickImage({ TPL: ctx.TPL, brand: ctx.BRAND.name, slot: spec.slot || 'photo', title: spec.label });
          if (!picked) return;
          if (picked.media) {
            ctx.set(['media', picked.id], picked.media, { quiet: true });
            ctx.uploadMedia(picked.id, picked.media);
          }
          // A new photograph starts with no alt text or credit: the old ones described a different image.
          ctx.set(path, { id: picked.id }, { structural: true });
        },
      }, has ? 'Change' : 'Choose'),
      has ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => ctx.set(path, undefined, { structural: true }) }, 'Remove') : null)));
  if (has) {
    const altId = `${id}-alt`;
    const alt = h('input', { id: altId, class: 'ed-input', value: str(ref.alt), autocomplete: 'off', placeholder: 'What the photograph shows' });
    alt.addEventListener('input', () => ctx.set([...toPath(path), 'alt'], alt.value || undefined));
    wrap.append(h('label', { class: 'ed-label ed-sub', for: altId }, 'Alt text', h('span', { class: 'ed-req', text: ' *' })), alt);
    if (spec.credit) {
      const crId = `${id}-credit`;
      const credit = h('input', { id: crId, class: 'ed-input', value: str(ref.credit), autocomplete: 'off', placeholder: `e.g. ${ctx.BRAND.name} photo · Client photo` });
      credit.addEventListener('input', () => ctx.set([...toPath(path), 'credit'], credit.value || undefined));
      wrap.append(h('label', { class: 'ed-label ed-sub', for: crId, text: 'Credit' }), credit);
    }
    const crop = ref.crop || {};
    const slider = (key, label, min, max, step, def) => {
      const sid = `${id}-${key}`;
      const input = h('input', { id: sid, type: 'range', min, max, step, value: crop[key] ?? def, class: 'ed-range' });
      input.addEventListener('input', () => {
        const next = { ...(ctx.get([...toPath(path), 'crop']) || {}), [key]: Number(input.value) };
        const plain = (!next.x) && (!next.y) && (!next.s || next.s === 1);
        ctx.set([...toPath(path), 'crop'], plain ? undefined : next);
      });
      return h('div', { class: 'ed-range-row' }, h('label', { for: sid, text: label }), input);
    };
    wrap.append(h('details', { class: 'ed-crop' }, h('summary', { text: 'Adjust framing' }),
      slider('s', 'Zoom', 1, 3, 0.01, 1), slider('x', 'Left / right', -50, 50, 0.5, 0), slider('y', 'Up / down', -50, 50, 0.5, 0)));
  }
  if (spec.help) wrap.append(h('p', { class: 'ed-hint', text: spec.help }));
  return wrap;
}

function rows(spec, ctx, path) {
  const list = Array.isArray(ctx.get(path)) ? ctx.get(path) : [];
  const box = h('div', { class: 'ed-rows', dataset: { path: toPath(path).join('.') } });
  const head = h('div', { class: 'ed-rows-head' }, h('p', { class: 'ed-label' }, h('span', {}, spec.label, h('span', { class: 'ed-count', text: ` · ${list.length}` }))));
  box.append(head);
  if (spec.help) box.append(h('p', { class: 'ed-hint', text: spec.help }));
  const write = (next) => ctx.set(path, next, { structural: true });
  list.forEach((row, i) => {
    const rowPath = [...toPath(path), i];
    const title = spec.title ? spec.title(row, i, ctx) : `${i + 1}`;
    const card = h('div', { class: 'ed-row' },
      h('div', { class: 'ed-row-head' },
        h('span', { class: 'ed-row-title', text: title }),
        h('div', { class: 'ed-row-tools' },
          h('button', { type: 'button', class: 'ed-icon', 'aria-label': `Move ${title} up`, disabled: i === 0, onclick: () => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; write(n); } }, icon('arrow-up')),
          h('button', { type: 'button', class: 'ed-icon', 'aria-label': `Move ${title} down`, disabled: i === list.length - 1, onclick: () => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; write(n); } }, icon('arrow-down')),
          spec.noDuplicate ? null : h('button', { type: 'button', class: 'ed-icon', 'aria-label': `Duplicate ${title}`, title: 'Duplicate', disabled: spec.max && list.length >= spec.max, onclick: () => { const n = [...list]; const copy = JSON.parse(JSON.stringify(row)); if (copy && copy.id) copy.id = spec.newId ? spec.newId() : `${copy.id}-copy`; n.splice(i + 1, 0, copy); write(n); } }, icon('copy')),
          h('button', { type: 'button', class: 'ed-icon ed-danger', 'aria-label': `Delete ${title}`, title: 'Delete', onclick: () => {
            const n = [...list];
            n.splice(i, 1);
            write(n);
            ctx.toast?.(`Deleted “${title}”`, () => write(list));
          } }, icon('trash-2')))));
    for (const col of spec.columns) card.append(renderField({ ...col, path: [...rowPath, ...toPath(col.path)] }, ctx));
    if (spec.extra) { const extra = spec.extra(row, i, ctx, rowPath); if (extra) card.append(extra); }
    box.append(card);
  });
  const tools = h('div', { class: 'ed-rows-tools' });
  tools.append(h('button', {
    type: 'button', class: 'btn btn--secondary btn--sm', disabled: spec.max && list.length >= spec.max,
    onclick: () => write([...list, spec.newRow ? spec.newRow(ctx) : {}]),
  }, icon('plus'), h('span', { text: spec.addLabel || 'Add' })));
  for (const p of spec.presets || []) {
    tools.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => p.insert(ctx) }, icon('book-open'), h('span', { text: p.label })));
  }
  box.append(tools);
  if (spec.max) box.append(h('p', { class: 'ed-hint', text: `Up to ${spec.max}.` }));
  return box;
}

export function note(text, tone = 'info') {
  return h('p', { class: `ed-note ed-note--${tone}` }, icon(tone === 'warn' ? 'alert-triangle' : tone === 'lock' ? 'lock' : 'info'), h('span', { text }));
}

export function renderField(spec, ctx) {
  const path = toPath(spec.path || []);
  switch (spec.type) {
    case 'text': case 'email': case 'date': case 'area': case 'paras': case 'lines': return textLike(spec, ctx, path);
    case 'select': return select(spec, ctx, path);
    case 'check': return check(spec, ctx, path);
    case 'money': case 'qty': return numberLike(spec, ctx, path);
    case 'image': return image(spec, ctx, path);
    case 'rows': return rows(spec, ctx, path);
    case 'note': return note(spec.text, spec.tone);
    case 'custom': return spec.render(ctx, path);
    default: return h('p', { text: `Unknown field ${spec.type}` });
  }
}
