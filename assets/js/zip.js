/**
 * A zip file, written in the browser, with nothing added to the page: the
 * record pack (record-pack.js) is assembled from files staff fetched and
 * checked, and handed over as one download.
 *
 * Files are STORED, not compressed: the pack's PDFs and photographs are
 * already compressed, and a stored file's bytes inside the zip are exactly
 * the bytes whose fingerprint the pack records — anyone can check them with
 * any unzip tool. Names are UTF-8 (general-purpose flag bit 11). No ZIP64: a
 * pack over 4 GB, or of more than 65,535 files, is refused rather than written
 * wrong.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, in local time as zip tools expect. */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * files: [{ name, bytes: Uint8Array | string }] in the order they should list.
 * Returns a Blob (application/zip).
 */
export function makeZip(files, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  if (files.length > 0xffff) throw new Error('Too many files for a zip without ZIP64.');
  const seen = new Set();
  for (const f of files) {
    const name = String(f.name).replace(/^\/+/, '');
    if (!name || seen.has(name) || name.includes('..') || name.includes('\\')) throw new Error(`Bad or repeated file name in the pack: ${name}`);
    seen.add(name);
    const nameBytes = enc.encode(name);
    const data = typeof f.bytes === 'string' ? enc.encode(f.bytes) : f.bytes;
    const crc = crc32(data);
    if (offset + 30 + nameBytes.length + data.length > 0xfffffffe) throw new Error('The pack is too large for a zip without ZIP64.');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);        // version needed
    local.setUint16(6, 0x0800, true);    // UTF-8 names
    local.setUint16(8, 0, true);         // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);           // made by
    cd.setUint16(6, 20, true);           // needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
