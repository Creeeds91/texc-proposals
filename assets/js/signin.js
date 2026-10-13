/** The staff sign-in page: an address, then the six-digit code emailed to it. */
const D = document;
const next = new URLSearchParams(location.search).get('next') || '/editor';
const step = (name) => {
  for (const card of D.querySelectorAll('[data-step]')) card.hidden = card.dataset.step !== name;
  setTimeout(() => D.getElementById(name === 'email' ? 'email' : 'code').focus(), 30);
};
let email = '';

const call = (action, payload) => fetch(`/api/auth?action=${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload),
});

D.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = D.getElementById('email-msg');
  const value = D.getElementById('email').value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { msg.textContent = 'Enter your work email address.'; return; }
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  msg.textContent = '';
  try {
    const r = await call('code', { email: value });
    if (r.status === 429) { msg.textContent = 'Too many attempts. Wait a minute and try again.'; return; }
    email = value;
    step('code');
  } catch { msg.textContent = 'That did not go through. Check your connection and try again.'; }
  finally { btn.disabled = false; }
});

D.getElementById('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = D.getElementById('code-msg');
  const code = D.getElementById('code').value.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) { msg.textContent = 'The code is six digits.'; return; }
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  msg.textContent = '';
  try {
    const r = await call('verify', { email, code, next });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { location.assign(j.next || '/editor'); return; }
    msg.textContent = r.status === 429 ? 'Too many attempts. Ask for a new code in a few minutes.' : (j.error || 'That code did not work.');
  } catch { msg.textContent = 'That did not go through. Check your connection and try again.'; }
  finally { btn.disabled = false; }
});

D.getElementById('restart').addEventListener('click', () => { D.getElementById('code').value = ''; step('email'); });
