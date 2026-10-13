/**
 * Small PDFs built in code, for the attachments checks — each one a way a file
 * can be safe or not. Nothing in them is TEXC content: the clean ones say only
 * that they are test files.
 *
 *   buildPdf(objects, { trailer })   objects: a string (the object's body) or
 *                                    { dict, data } for a stream; object 1 is the catalog
 *   FIXTURES                          name → { bytes(), status, overridable }
 */
import { deflateSync } from 'node:zlib';

export function buildPdf(objects, { trailer = '' } = {}) {
  const parts = [Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(length);
    const buf = typeof o === 'string'
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(buf);
    length += buf.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A plain document: `pages` pages of Helvetica text. `catalog` adds to the
 * catalog dictionary. `compress: false` stores the text as it is, so two files
 * whose lines are the same length are exactly the same size.
 */
export function textPdf(lines, { pages = 1, catalog = '', extra = [], compress = true } = {}) {
  const pageObjs = [];
  const objects = [null, null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let p = 0; p < pages; p += 1) {
    const text = [`BT /F1 20 Tf 72 770 Td (${esc(lines[0] || 'Test document')}) Tj ET`,
      ...lines.slice(1).map((l, i) => `BT /F1 12 Tf 72 ${730 - i * 18} Td (${esc(l)}) Tj ET`),
      `BT /F1 10 Tf 72 40 Td (Page ${p + 1} of ${pages}) Tj ET`].join('\n');
    objects.push(compress ? { dict: '/Filter /FlateDecode', data: deflateSync(Buffer.from(text, 'latin1')) } : { dict: '', data: Buffer.from(text, 'latin1') });
    const contentRef = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`);
    pageObjs.push(objects.length);
  }
  const extraStart = objects.length + 1;
  objects.push(...extra);
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${catalog.replace(/\$EXTRA/g, String(extraStart))}>>`;
  objects[1] = `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`;
  return buildPdf(objects);
}

const TEST = ['Test document', 'This file exists only to test the attachment checks.', 'It carries no proposal content.'];

export const FIXTURES = {
  'clean, one page': { bytes: () => textPdf(TEST), status: 'clean', overridable: false, pages: 1 },
  'clean, three pages': { bytes: () => textPdf(TEST, { pages: 3 }), status: 'clean', overridable: false, pages: 3 },
  'a bare /OpenAction (just sets the zoom)': { bytes: () => textPdf(TEST, { catalog: '/OpenAction [5 0 R /Fit] ' }), status: 'clean', overridable: false, pages: 1 },
  '/JavaScript inside a compressed object stream': {
    bytes: () => {
      const body = '<< /S /JavaScript /JS (app.alert\\(1\\)) >>';
      return textPdf(TEST, { catalog: '/OpenAction 7 0 R ', extra: [{ dict: `/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode`, data: deflateSync(Buffer.from(`7 0 ${body}`, 'latin1')) }] });
    },
    status: 'rejected', overridable: true,
  },
  'a name hidden with #xx escapes (/J#61vaScript)': { bytes: () => textPdf(TEST, { catalog: '/Names << /J#61vaScript $EXTRA 0 R >> ', extra: ['<< /Names [] >>'] }), status: 'rejected', overridable: true },
  'a /Launch action': { bytes: () => textPdf(TEST, { catalog: '/OpenAction $EXTRA 0 R ', extra: ['<< /S /Launch /F (calc.exe) >>'] }), status: 'rejected', overridable: true },
  'an embedded file': { bytes: () => textPdf(TEST, { catalog: '/Names << /EmbeddedFiles $EXTRA 0 R >> ', extra: ['<< /Names [] >>'] }), status: 'rejected', overridable: true },
  'ASCII85 over Flate, hiding /JS': {
    bytes: () => {
      const a85 = (buf) => {
        let out = '';
        for (let i = 0; i < buf.length; i += 4) {
          const chunk = Buffer.alloc(4);
          buf.copy(chunk, 0, i, Math.min(i + 4, buf.length));
          let n = chunk.readUInt32BE(0);
          const len = Math.min(4, buf.length - i);
          if (n === 0 && len === 4) { out += 'z'; continue; }
          const c = [];
          for (let k = 0; k < 5; k += 1) { c.unshift(String.fromCharCode(33 + (n % 85))); n = Math.floor(n / 85); }
          out += c.join('').slice(0, len + 1);
        }
        return `${out}~>`;
      };
      const data = Buffer.from(a85(deflateSync(Buffer.from('7 0 << /S /JavaScript /JS (x) >>', 'latin1'))), 'latin1');
      return textPdf(TEST, { extra: [{ dict: '/Type /ObjStm /N 1 /First 4 /Filter [/ASCII85Decode /FlateDecode]', data }] });
    },
    status: 'rejected', overridable: true,
  },
  'encrypted': {
    bytes: () => {
      const b = textPdf(TEST).toString('latin1');
      return Buffer.from(b.replace('/Root 1 0 R ', '/Root 1 0 R /Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <00> /U <00> >> '), 'latin1');
    },
    status: 'rejected', overridable: false,
  },
  'not a PDF (a renamed file)': { bytes: () => Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(4096, 7)]), status: 'rejected', overridable: false },
  'over 25 MB': { bytes: () => Buffer.concat([textPdf(TEST), Buffer.alloc(25 * 1024 * 1024, 0x20)]), status: 'rejected', overridable: false },
  'a "zip bomb" (one stream that inflates past 96 MB)': {
    bytes: () => textPdf(TEST, { extra: [{ dict: '/Filter /FlateDecode', data: deflateSync(Buffer.alloc(128 * 1024 * 1024, 0), { level: 9 }) }] }),
    status: 'rejected', overridable: false, slow: true,
  },
  'streams that only add up past 256 MB (a large drawing can)': {
    bytes: () => { const z = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 }); return textPdf(TEST, { extra: Array.from({ length: 5 }, () => ({ dict: '/Filter /FlateDecode', data: z })) }); },
    status: 'cannot-verify', overridable: true, slow: true,
  },
  'JavaScript after the budget runs out is still found in the uncompressed part': {
    bytes: () => { const z = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 }); return textPdf(TEST, { catalog: '/OpenAction $EXTRA 0 R ', extra: ['<< /S /JavaScript /JS (x) >>', ...Array.from({ length: 5 }, () => ({ dict: '/Filter /FlateDecode', data: z }))] }); },
    status: 'rejected', overridable: true, slow: true,
  },
  'a stream in a filter the check cannot read (LZW)': { bytes: () => textPdf(TEST, { extra: [{ dict: '/Filter /LZWDecode', data: Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]) }] }), status: 'cannot-verify', overridable: true },
  'no pages at all': { bytes: () => buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']), status: 'cannot-verify', overridable: true },
};
