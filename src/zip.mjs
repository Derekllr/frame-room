// Stored ZIP entries avoid wasting CPU recompressing JPEGs.
const CRC_TABLE = Uint32Array.from({length:256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function makeZip(entries) {
  const parts = [], central = [];
  let position = 0, centralSize = 0;
  for (const {name, blob} of entries) {
    const bytes = new TextEncoder().encode(name), len = blob.size;
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const local = new Uint8Array(30 + bytes.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true); l.setUint16(12, 0x21, true);
    l.setUint32(14, crc, true); l.setUint32(18, len, true); l.setUint32(22, len, true);
    l.setUint16(26, bytes.length, true); local.set(bytes, 30);
    const entry = new Uint8Array(46 + bytes.length), d = new DataView(entry.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true); d.setUint16(14, 0x21, true); d.setUint32(16, crc, true);
    d.setUint32(20, len, true); d.setUint32(24, len, true); d.setUint16(28, bytes.length, true);
    d.setUint32(42, position, true); entry.set(bytes, 46);
    parts.push(local, blob); central.push(entry);
    position += local.length + len; centralSize += entry.length;
  }
  const end = new Uint8Array(22), d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true); d.setUint16(8, entries.length, true); d.setUint16(10, entries.length, true);
  d.setUint32(12, centralSize, true); d.setUint32(16, position, true);
  return new Blob([...parts, ...central, end], {type:'application/zip'});
}
