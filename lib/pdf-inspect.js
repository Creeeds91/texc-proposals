/**
 * Is this PDF safe to hand a client? A structural check, dependency-free.
 *
 *   inspectPdf(bytes) -> { status, reasons, overridable, pages, bytes, sha256 }
 *     status  'clean'          nothing active found in any object we could read
 *             'rejected'       something a client must not be sent (reasons say what)
 *             'cannot-verify'  part of the file could not be decoded, so it was
 *                              not checked — treated like rejected unless an
 *                              administrator overrides it with a reason
 *   overridable  whether an administrator may still release it, with a reason:
 *                true for active content and for "cannot verify"; never for a
 *                file that is not a PDF, too large, encrypted or a "zip bomb",
 *                which cannot be served safely whatever anyone decides
 *
 * What it does (docs/architecture.md §5, Q6 option A):
 *   - the file must start with %PDF- and be at most 25 MB; an encrypted PDF is refused
 *   - every non-image stream is decoded (Flate, ASCII85, ASCIIHex, chained) and
 *     scanned on its own, then let go, so memory stays bounded by one stream.
 *     Object streams are decoded like any other: nothing compressed escapes.
 *   - two budgets bound the work. One stream expanding past 96 MB is a "zip
 *     bomb" and is refused. A file whose streams only ADD UP past 256 MB (a
 *     large vector drawing can) stops being checked there and is "cannot
 *     verify", which an administrator may release — a genuine drawing must
 *     never be refused outright for its size.
 *   - names are matched after #xx escapes are decoded (/J#61vaScript is /JavaScript)
 *   - refused anywhere: /JavaScript /JS /Launch /EmbeddedFile(s) /RichMedia /XFA
 *     /SubmitForm /ImportData. An /OpenAction or /AA is allowed only because
 *     whatever it points at is scanned too (a bare /OpenAction just sets the zoom).
 *   - image streams (DCT, JPX, CCITT, JBIG2, or /Subtype /Image) are skipped:
 *     image data cannot hold PDF objects
 *
 * TEXC's own suite PDFs carry Acrobat JavaScript (their calculations), so they
 * are refused by design: attach a flattened (printed-to-PDF) copy instead.
 */
import { inflateSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';

export const MAX_BYTES = 25 * 1024 * 1024;
export const PER_STREAM = 96 * 1024 * 1024;
export const TOTAL = 256 * 1024 * 1024;
const DANGER = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData)(?![A-Za-z0-9#._-])/g;
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);
const LABEL = {
  JavaScript: 'JavaScript', JS: 'JavaScript', Launch: 'an action that launches a program', EmbeddedFile: 'an embedded file',
  EmbeddedFiles: 'embedded files', RichMedia: 'rich media (Flash or video)', XFA: 'an XFA form', SubmitForm: 'a form that submits data', ImportData: 'a form that imports data',
};

const unescapeNames = (s) => s.replace(/#([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

class Bomb extends Error {}
class TooMuch extends Error {}
class Undecodable extends Error {}

function a85(buf) {
  const s = buf.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) throw new Undecodable('ASCII85');
    group.push(c);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length) {
    const len = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, len - 1));
  }
  return Buffer.from(out);
}

function ahx(buf) {
  const s = buf.toString('latin1').replace(/\s+/g, '').replace(/>.*$/, '');
  if (/[^0-9a-fA-F]/.test(s)) throw new Undecodable('ASCIIHex');
  return Buffer.from(s.length % 2 ? s + '0' : s, 'hex');
}

function decode(data, filters, budget) {
  let out = data;
  // Which limit a stream would cross: its own (a bomb) or the file's running total (too much to check).
  const over = () => (budget.left < PER_STREAM ? new TooMuch() : new Bomb());
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      try {
        out = inflateSync(out, { maxOutputLength: Math.max(1, Math.min(PER_STREAM, budget.left)), finishFlush: constants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer|RangeError/i.test(`${e.code} ${e.message} ${e.name}`))) throw over();
        throw new Undecodable('Flate');
      }
    } else if (f === 'ASCII85Decode' || f === 'A85') out = a85(out);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') out = ahx(out);
    else throw new Undecodable(f);
    if (out.length > PER_STREAM) throw new Bomb();
    if (out.length > budget.left) throw new TooMuch();
  }
  budget.left -= out.length;
  return out;
}

/** Every stream: its dictionary text and raw bytes. */
function* streams(buf, text) {
  const re = /stream(\r\n|\n|\r)/g;
  let m;
  while ((m = re.exec(text))) {
    if (text.slice(m.index - 3, m.index) === 'end') continue; // "endstream"
    // The dictionary is the nearest balanced << … >> ending just before "stream".
    const before = text.slice(Math.max(0, m.index - 4096), m.index).replace(/\s+$/, '');
    if (!before.endsWith('>>')) continue;
    let depth = 0;
    let start = -1;
    for (let i = before.length - 1; i > 0; i -= 1) {
      if (before[i] === '>' && before[i - 1] === '>') { depth += 1; i -= 1; continue; }
      if (before[i] === '<' && before[i - 1] === '<') { depth -= 1; i -= 1; if (depth === 0) { start = i - 1; break; } }
    }
    const dict = start >= 0 ? before.slice(start) : before;
    const dataStart = m.index + m[0].length;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = -1;
    if (len) {
      const end = dataStart + Number(len[1]);
      if (/^\s*endstream/.test(text.slice(end, end + 20))) dataEnd = end;
    }
    if (dataEnd < 0) {
      const e = text.indexOf('endstream', dataStart);
      if (e < 0) continue;
      dataEnd = e;
      while (dataEnd > dataStart && (text[dataEnd - 1] === '\n' || text[dataEnd - 1] === '\r')) dataEnd -= 1;
    }
    re.lastIndex = dataEnd;
    yield { dict: unescapeNames(dict), data: buf.subarray(dataStart, dataEnd) };
  }
}

export function inspectPdf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = { status: 'clean', reasons: [], overridable: false, pages: 0, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  const refuse = (r) => { if (!result.reasons.includes(r)) result.reasons.push(r); result.status = 'rejected'; };
  if (buf.length > MAX_BYTES) { refuse('It is larger than 25 MB.'); return result; }
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) { refuse('It is not a PDF.'); return result; }
  const text = buf.toString('latin1');
  const top = unescapeNames(text);
  if (/\/Encrypt(?![A-Za-z])/.test(top)) { refuse('It is encrypted or password-protected.'); return result; }

  const scan = (t) => {
    for (const m of t.matchAll(DANGER)) refuse(`It contains ${LABEL[m[1]]} (/${m[1]}).`);
    result.pages += (t.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  };
  scan(top);
  const budget = { left: TOTAL };
  let undecodable = 0;
  let unchecked = false;
  for (const s of streams(buf, text)) {
    const filters = [...(s.dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/) || ['', ''])[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]);
    if (/\/Subtype\s*\/Image\b/.test(s.dict) || filters.some((f) => IMAGE_FILTERS.has(f))) continue;
    if (/\/Type\s*\/XRef\b/.test(s.dict)) continue; // offsets only
    if (!filters.length) continue; // an uncompressed stream was already read as part of the file
    try {
      scan(unescapeNames(decode(s.data, filters, budget).toString('latin1')));
    } catch (e) {
      if (e instanceof Bomb) { refuse('A compressed part expands beyond the safe limit (a possible "zip bomb").'); return result; }
      if (e instanceof TooMuch) { unchecked = true; break; }
      undecodable += 1;
    }
  }
  // Active content is a judgement an administrator may make (TEXC's own forms
  // carry calculation scripts); everything refused above this line is not.
  if (result.status === 'rejected') { result.overridable = true; return result; }
  if (result.status === 'clean' && unchecked) {
    result.status = 'cannot-verify';
    result.reasons.push('It expands to more than 256 MB, so it was only partly checked.');
  }
  if (result.status === 'clean' && undecodable) {
    result.status = 'cannot-verify';
    result.reasons.push(`${undecodable} part${undecodable === 1 ? '' : 's'} of the file could not be decoded, so ${undecodable === 1 ? 'it was' : 'they were'} not checked.`);
  }
  if (result.status === 'clean' && result.pages === 0) {
    result.status = 'cannot-verify';
    result.reasons.push('No pages were found.');
  }
  result.overridable = result.status === 'cannot-verify';
  return result;
}
