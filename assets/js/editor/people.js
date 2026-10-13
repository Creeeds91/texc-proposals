/**
 * People: who may use the editor, for administrators. Pending requests first,
 * each with Approve; everyone else with their role and an on/off status.
 * An admin manages editors and viewers; only Brand in Black can change an admin.
 */
import { h, icon } from './dom.js';
import { api } from './api.js';

const ROLES = [['editor', 'Editor — builds and publishes'], ['viewer', 'Viewer — reads only'], ['admin', 'Administrator']];

export function openPeople(ctx) {
  const dlg = h('dialog', { class: 'ed-dialog ed-dialog--wide', 'aria-labelledby': 'people-title' });
  const body = h('div', {}, h('p', { class: 'ed-hint', text: 'Loading…' }));
  dlg.append(
    h('div', { class: 'ed-dialog-head' }, h('h2', { id: 'people-title', text: 'People' }), h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('p', { class: 'ed-hint', text: 'Anyone with a work address can ask for access from the sign-in page. They see nothing until approved here.' }),
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();

  const save = async (email, patch, done) => {
    const r = await api('POST', '/api/people', { email, ...patch });
    if (!r.ok) { ctx.toast((r.json && r.json.error) || 'That could not be saved.'); }
    else ctx.toast(done);
    load();
  };

  async function load() {
    const r = await api('GET', '/api/people');
    if (!r.ok) { body.replaceChildren(h('p', { class: 'ed-hint', text: (r.json && r.json.error) || 'The list could not be loaded.' })); return; }
    const me = r.json.me;
    const people = r.json.people.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
    if (!people.length) { body.replaceChildren(h('p', { class: 'ed-hint', text: 'Nobody yet.' })); return; }
    body.replaceChildren(h('ul', { class: 'ed-people' }, people.map((p) => {
      const isSelf = p.email === me.email;
      const locked = isSelf || p.role === 'super' || (p.role === 'admin' && me.role !== 'super');
      const row = h('li', { class: `ed-person is-${p.status}` },
        h('div', { class: 'ed-person-who' },
          h('strong', { text: p.email }),
          h('span', { class: 'ed-hint', text: p.role === 'super' ? 'Brand in Black' : `${p.status}${p.last_seen_at ? ` · last in ${new Date(p.last_seen_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : ''}` })));
      if (locked) { row.append(h('span', { class: 'ed-badge', text: p.role === 'super' ? 'Brand in Black' : isSelf ? 'You' : 'Administrator' })); return row; }
      const role = h('select', { class: 'ed-input ed-person-role', 'aria-label': `Role for ${p.email}` }, ROLES.filter(([v]) => v !== 'admin' || me.role === 'super').map(([v, l]) => h('option', { value: v, text: l })));
      role.value = p.role;
      role.addEventListener('change', () => save(p.email, { role: role.value }, `${p.email} is now ${role.value === 'admin' ? 'an administrator' : `a ${role.value}`}.`));
      const tools = h('div', { class: 'ed-person-tools' }, role);
      if (p.status === 'pending') tools.append(h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => save(p.email, { status: 'active', role: role.value }, `${p.email} approved and emailed.`) }, 'Approve'));
      else if (p.status === 'active') tools.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => { if (window.confirm(`Suspend ${p.email}? They are signed out at once.`)) save(p.email, { status: 'suspended' }, `${p.email} suspended.`); } }, 'Suspend'));
      else tools.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => save(p.email, { status: 'active' }, `${p.email} restored.`) }, 'Restore'));
      row.append(tools);
      return row;
    })));
  }
  load();
}
