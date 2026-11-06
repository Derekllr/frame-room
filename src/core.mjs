export const LIMITS = Object.freeze({ count: 100, bytes: 60 * 1024 ** 2, pixels: 80_000_000, edge: 1600, target: 500_000, shelf: 60 * 1024 ** 2 });
export class PhotoError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function fit(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

function jpegOrientation(view, start, end) {
  if (end - start < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return 1;
  const offset = start + 6;
  const endian = view.getUint16(offset);
  if (endian !== 0x4949 && endian !== 0x4d4d) return 1;
  const le = endian === 0x4949;
  if (view.getUint16(offset + 2, le) !== 42) return 1;
  const dir = offset + view.getUint32(offset + 4, le);
  if (dir < offset + 8 || dir + 2 > end) return 1;
  const entries = view.getUint16(dir, le);
  for (let i = 0; i < entries; i++) {
    const at = dir + 2 + i * 12;
    if (at + 12 > end) break;
    if (view.getUint16(at, le) === 0x112 && view.getUint16(at + 2, le) === 3 && view.getUint32(at + 4, le) === 1) {
      const value = view.getUint16(at + 8, le);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

export function photoHeader(buffer) {
  const view = new DataView(buffer);
  const n = view.byteLength;
  let width = 0, height = 0, orientation = 1, type;
  if (n >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    type = 'image/png';
    width = view.getUint32(16); height = view.getUint32(20);
    for (let at = 8; at + 12 <= n;) {
      const size = view.getUint32(at), tag = view.getUint32(at + 4);
      if (tag === 0x6163544c) throw new PhotoError('animated');
      if (tag === 0x49444154 || at + 12 + size > n) break;
      at += size + 12;
    }
  } else if (n >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    type = 'image/webp';
    const tag = view.getUint32(12);
    if (tag === 0x56503858) {
      if (view.getUint8(20) & 2) throw new PhotoError('animated');
      const u24 = at => view.getUint8(at) + 256 * view.getUint8(at + 1) + 65536 * view.getUint8(at + 2);
      width = 1 + u24(24); height = 1 + u24(27);
    } else if (tag === 0x5650384c && view.getUint8(20) === 0x2f) {
      const packed = view.getUint32(21, true);
      width = 1 + (packed & 0x3fff); height = 1 + ((packed >>> 14) & 0x3fff);
    } else if (tag === 0x56503820 && view.getUint8(23) === 0x9d && view.getUint8(24) === 1 && view.getUint8(25) === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
  } else if (n >= 4 && view.getUint16(0) === 0xffd8) {
    type = 'image/jpeg';
    let at = 2;
    while (at + 3 < n && view.getUint8(at++) === 0xff) {
      while (at < n && view.getUint8(at) === 0xff) at++;
      if (at + 2 >= n) break;
      const marker = view.getUint8(at++);
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(at);
      if (length < 2 || at + length > n) break;
      if (marker === 0xe1 && length >= 16 && view.getUint32(at + 2) === 0x45786966) {
        orientation = jpegOrientation(view, at + 2, at + length);
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5);
      }
      at += length;
    }
  }
  if (!type) throw new PhotoError('unsupported');
  if (!width || !height) throw new PhotoError('unreadable');
  if (width * height > LIMITS.pixels) throw new PhotoError('pixels');
  if (orientation >= 5) [width, height] = [height, width];
  return {width, height, orientation, type};
}

export function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

export function standings(photos, votes) {
  const stats = new Map(photos.map((photo, index) => [photo.id, {photo, index, rating:1000, played:0, wins:0, ties:0}]));
  const pairCounts = new Map();
  for (const {a, b, outcome} of votes) {
    const x = stats.get(a), y = stats.get(b);
    if (!x || !y || x === y || !['a', 'b', 'tie'].includes(outcome)) continue;
    const expected = 1 / (1 + 10 ** ((y.rating - x.rating) / 400));
    const actual = outcome === 'a' ? 1 : outcome === 'b' ? 0 : 0.5;
    const change = 32 * (actual - expected);
    x.rating += change; y.rating -= change;
    x.played++; y.played++;
    if (outcome === 'a') x.wins++;
    else if (outcome === 'b') y.wins++;
    else { x.ties++; y.ties++; }
    const key = pairKey(a, b);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }
  const ranked = [...stats.values()].sort((a, b) => Number(b.played > 0) - Number(a.played > 0) || b.rating - a.rating || a.index - b.index);
  return { ranked, pairCounts };
}

export function nextPair(photos, votes, previous, random = Math.random) {
  if (photos.length < 2) return null;
  const { ranked, pairCounts } = standings(photos, votes);
  const shuffled = ranked.map(item => ({...item, roll:random()})).sort((a, b) => a.played - b.played || a.roll - b.roll);
  const a = shuffled[0];
  let candidates = shuffled.slice(1);
  if (previous && photos.length > 2) {
    const last = pairKey(previous.a, previous.b);
    candidates = candidates.filter(b => pairKey(a.photo.id, b.photo.id) !== last);
  }
  const priorMeetings = b => pairCounts.get(pairKey(a.photo.id, b.photo.id)) || 0;
  candidates.sort((b, c) => b.played - c.played || priorMeetings(b) - priorMeetings(c) || b.roll - c.roll);
  const b = candidates[0];
  return random() < .5 ? {a:a.photo.id, b:b.photo.id} : {a:b.photo.id, b:a.photo.id};
}

export function exportName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'photo';
}
