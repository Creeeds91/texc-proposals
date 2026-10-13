/** GET /signin — the sign-in page. Public; it holds nothing. */
import { SIGNIN_HTML } from '../lib/signin-html.js';
import { CLIENT_CSP } from '../lib/csp.js';

export default function handler(req, res) {
  res.setHeader('Content-Security-Policy', CLIENT_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(SIGNIN_HTML);
}
