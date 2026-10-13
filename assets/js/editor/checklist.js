/**
 * The pre-publish checklist, and publishing from it.
 *
 * It lists exactly what assets/js/checks.js finds — the same rules the server
 * applies when it publishes — so nothing passes here that the server refuses.
 * Ticking an acknowledgement updates the verdict in place; the list never
 * redraws under the pointer. When it reads "Ready", Publish saves the draft,
 * publishes that exact version, and shows the link and (first time only) the
 * passphrase, each with Copy, and how to send them.
 */
import { h, icon } from './dom.js';
import { runChecks } from '../checks.js';
import { api } from './api.js';

const nextLabel = (p) => {
  const n = (p && p.revisions ? p.revisions.length : 0) + 1;
  let s = ''; let x = n;
  while (x > 0) { x -= 1; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26); }
  return s;
};

export function openChecklist(ctx) {
  const dlg = h('dialog', { class: 'ed-dialog ed-dialog--wide', 'aria-labelledby': 'ck-title' });
  const r = runChecks(ctx.cfg(), ctx.checkCtx());
  const verdict = h('p', { class: 'ed-verdict', role: 'status' });
  const publishBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-publish' });
  const proposal = ctx.proposal();
  const issuedBefore = !!(proposal && proposal.revisions && proposal.revisions.length);
  const label = nextLabel(proposal);
  publishBtn.textContent = issuedBefore ? `Publish Rev ${label}` : 'Publish and create the link';

  const showVerdict = () => {
    const now = runChecks(ctx.cfg(), ctx.checkCtx());
    const acked = new Set(ctx.get('acks') || []);
    const pending = now.acks.filter((a) => !acked.has(a.key)).length;
    const tone = now.ready ? 'is-ready' : now.blockers.length ? 'is-blocked' : 'is-pending';
    verdict.className = `ed-verdict ${tone}`;
    verdict.replaceChildren(icon(now.ready ? 'check-circle' : 'alert-triangle'),
      now.ready ? ' Ready to publish.' : ` ${now.blockers.length} to fix · ${pending} to acknowledge`);
    publishBtn.disabled = !now.ready || !ctx.proposalId();
  };
  const acked = new Set(ctx.get('acks') || []);
  const changes = h('div', {}, h('p', { class: 'ed-hint', text: issuedBefore ? 'Comparing with the last revision…' : 'This will be the first revision.' }));
  const email = String(ctx.get('client.email') || '');
  const emailBox = h('input', { type: 'checkbox', id: 'ck-email', class: 'ed-check' });
  const note = h('textarea', { id: 'ck-note', class: 'ed-input ed-area', rows: 2, placeholder: 'e.g. Rates confirmed; hold point HP2 added' });
  const msg = h('p', { class: 'ed-error', role: 'alert' });

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
    h('section', { class: 'ed-ck' }, h('h3', { text: 'Changes since the last revision' }), changes),
    h('section', { class: 'ed-ck' }, h('h3', { text: 'Publish' }),
      issuedBefore ? h('div', { class: 'ed-field' }, h('label', { class: 'ed-label', for: 'ck-note' }, 'What changed (kept with the revision)'), note) : null,
      email ? h('div', { class: 'ed-field ed-field--check' }, emailBox, h('label', { for: 'ck-email', text: `Email the link to ${email}. The passphrase is never in the email.` })) : h('p', { class: 'ed-hint', text: 'No client email on the cover, so the link will not be emailed.' })),
    h('div', { class: 'ed-dialog-foot' }, publishBtn, msg),
  );
  showVerdict();

  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    msg.textContent = '';
    publishBtn.textContent = 'Saving…';
    if (!(await ctx.flush())) { msg.textContent = 'The draft could not be saved, so nothing was published.'; publishBtn.disabled = false; publishBtn.textContent = 'Try again'; return; }
    publishBtn.textContent = 'Publishing…';
    const res = await api('POST', '/api/proposals', { action: 'publish', id: ctx.proposalId(), version: ctx.version(), changeNote: note.value.trim(), emailClient: emailBox.checked });
    if (!res.ok) {
      const j = res.json || {};
      const detail = j.detail && j.detail.blockers ? ` ${j.detail.blockers.map((b) => b.message).join('; ')}` : '';
      msg.textContent = `${j.error || 'Publishing failed.'}${detail}`;
      publishBtn.disabled = false;
      publishBtn.textContent = issuedBefore ? `Publish Rev ${label}` : 'Publish and create the link';
      return;
    }
    await ctx.refreshProposal();
    showResult(dlg, res.json, ctx);
  });

  dlg.addEventListener('close', () => { dlg.remove(); ctx.refresh(); });
  document.body.append(dlg);
  dlg.showModal();

  if (issuedBefore && ctx.proposalId()) {
    ctx.flush().then(() => api('GET', `/api/proposals?id=${ctx.proposalId()}&changes=1`)).then((c) => {
      if (!c.ok || !c.json.changes) { changes.replaceChildren(h('p', { class: 'ed-hint', text: 'The comparison is not available.' })); return; }
      const list = c.json.changes;
      changes.replaceChildren(list.length
        ? h('ul', {}, list.map((x) => h('li', {}, h('strong', { text: x.label }), ` — ${x.kind}`)))
        : h('p', { class: 'ed-hint', text: 'Nothing the client sees has changed since the last revision.' }));
    });
  }
}

function section(title, items, empty) {
  return h('section', { class: 'ed-ck' }, h('h3', { text: title }), items.length ? h('ul', {}, items) : h('p', { class: 'ed-hint', text: empty }));
}

function copyRow(label, value, ctx) {
  return h('div', { class: 'ed-secret' },
    h('p', { class: 'ed-label', text: label }),
    h('div', { class: 'ed-secret-row' }, h('code', { text: value }),
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
        try { await navigator.clipboard.writeText(value); ctx.toast(`${label} copied`); } catch { window.prompt('Copy this:', value); }
      } }, 'Copy')));
}

function showResult(dlg, out, ctx) {
  const emailed = out.emailed ? (out.emailed.ok ? 'The link was emailed to the client.' : `The link was not emailed (${out.emailed.reason || 'send failed'}). Send it yourself.`) : '';
  // replaceChildren would print a null as the text "null": keep only real nodes.
  dlg.replaceChildren(...[
    h('div', { class: 'ed-dialog-head' },
      h('h2', { id: 'ck-title', text: `Published — Rev ${out.rev}` }),
      h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('p', { class: 'ed-verdict is-ready', role: 'status' }, icon('check-circle'), ` ${out.reference} · Rev ${out.rev} is live.`),
    copyRow('Client link', out.url, ctx),
    out.passphrase
      ? copyRow('Passphrase', out.passphrase, ctx)
      : h('p', { class: 'ed-hint ed-block', text: 'The link and passphrase are unchanged. The client sees this revision the next time they open it, and can still open earlier ones.' }),
    out.passphrase ? h('p', { class: 'ed-note ed-note--warn' }, icon('alert-triangle'), h('span', { text: 'Send the link and the passphrase separately: the link by email, the passphrase by phone or text message. Anyone with both can open the proposal.' })) : null,
    emailed ? h('p', { class: 'ed-hint ed-block', text: emailed }) : null,
    h('p', { class: 'ed-hint ed-block', text: `The link stays open until ${new Date(out.linkExpiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}.` }),
  ].filter(Boolean));
}
