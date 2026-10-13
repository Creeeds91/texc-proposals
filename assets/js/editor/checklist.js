/**
 * The pre-publish checklist, shown before anything can be published. It lists
 * exactly what assets/js/checks.js finds — the same rules the server applies
 * from Phase 3 — so nothing passes here that the server will refuse.
 */
import { h, icon } from './dom.js';
import { runChecks } from '../checks.js';

export function openChecklist(ctx) {
  const dlg = h('dialog', { class: 'ed-dialog ed-dialog--wide', 'aria-labelledby': 'ck-title' });
  const r = runChecks(ctx.cfg(), ctx.checkCtx());
  const verdict = h('p', { class: 'ed-verdict', role: 'status' });
  // Ticking an acknowledgement updates the verdict in place: the list never
  // redraws under the pointer, so the reader keeps their place.
  const showVerdict = () => {
    const now = runChecks(ctx.cfg(), ctx.checkCtx());
    const acked = new Set(ctx.get('acks') || []);
    const pending = now.acks.filter((a) => !acked.has(a.key)).length;
    const tone = now.ready ? 'is-ready' : now.blockers.length ? 'is-blocked' : 'is-pending';
    verdict.className = `ed-verdict ${tone}`;
    verdict.replaceChildren(icon(now.ready ? 'check-circle' : 'alert-triangle'),
      now.ready ? ' Ready to publish.' : ` ${now.blockers.length} to fix · ${pending} to acknowledge`);
  };
  const acked = new Set(ctx.get('acks') || []);
  dlg.append(
    h('div', { class: 'ed-dialog-head' },
      h('h2', { id: 'ck-title', text: 'Before publishing' }),
      h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    verdict,
    section('To fix', r.blockers.map((b) => h('li', {},
      h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => { dlg.close(); ctx.reveal(b.section, b.field); } }, b.label),
      h('span', { text: ` — ${b.message}` }))), 'Nothing to fix.'),
    section('To acknowledge', r.acks.map((a) => {
      const id = `ack-${a.key.replace(/[^\w-]/g, '_')}`;
      const cb = h('input', { type: 'checkbox', id, class: 'ed-check' });
      cb.checked = acked.has(a.key);
      cb.addEventListener('change', () => {
        const now = new Set(ctx.get('acks') || []);
        if (cb.checked) now.add(a.key); else now.delete(a.key);
        ctx.set('acks', now.size ? [...now] : undefined);
        showVerdict();
      });
      return h('li', { class: 'ed-ack' }, cb, h('label', { for: id }, h('strong', { text: a.label }), ` — ${a.message}`, a.detail ? h('span', { class: 'ed-hint ed-block', text: a.detail }) : null));
    }), 'Nothing to acknowledge.'),
    section('Worth knowing', r.warnings.map((w) => h('li', {}, h('strong', { text: w.label }), ` — ${w.message}`)), 'Nothing.'),
    section('Changes since the last revision', [], 'Shown here from Phase 3, when revisions are stored.'),
    h('div', { class: 'ed-dialog-foot' },
      h('button', { type: 'button', class: 'btn btn--primary', disabled: true, title: 'Publishing arrives in Phase 3' }, 'Publish'),
      h('p', { class: 'ed-hint', text: 'Publishing — encryption, the link and passphrase — arrives in Phase 3.' })),
  );
  showVerdict();
  dlg.addEventListener('close', () => { dlg.remove(); ctx.refresh(); });
  document.body.append(dlg);
  dlg.showModal();
}

function section(title, items, empty) {
  return h('section', { class: 'ed-ck' }, h('h3', { text: title }), items.length ? h('ul', {}, items) : h('p', { class: 'ed-hint', text: empty }));
}
