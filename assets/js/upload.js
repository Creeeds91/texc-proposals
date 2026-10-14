/**
 * A PDF from the browser to the private bucket, for the editor and the
 * Documents page alike (lib/attachments.js is the server's half): the browser
 * hashes the file, the server names where it goes, and the bytes go straight
 * to storage with progress, never through a function.
 */
export const MAX_PDF = 25 * 1024 * 1024;

export const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Why a chosen file cannot go up, or null. */
export function pdfProblem(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return 'Only PDF files can be attached.';
  if (file.size > MAX_PDF) return 'That file is larger than 25 MB.';
  return null;
}

/** The name it is stored and offered under. */
export const pdfName = (file) => (/\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`);

export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PUT the bytes to a one-off upload URL, with progress. Resolves true when stored (or already there). */
export function putFile(url, buf, onProgress) {
  return new Promise((done) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', 'application/pdf');
    x.setRequestHeader('x-upsert', 'false');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onload = () => done(x.status < 300 || /Duplicate|already exists/i.test(x.responseText || ''));
    x.onerror = () => done(false);
    x.send(buf);
  });
}
