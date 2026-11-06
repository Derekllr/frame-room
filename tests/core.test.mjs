import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fit, photoHeader, nextPair, pairKey, standings, exportName} from '../src/core.mjs';
import {crc32, makeZip} from '../src/zip.mjs';
import {translate} from '../src/i18n.mjs';

const buf = bytes => Uint8Array.from(bytes).buffer;
test('a 24 MP landscape becomes 1600 px wide without changing aspect', () => {
  assert.deepEqual(fit(6000,4000,1600),{width:1600,height:1067});
  assert.deepEqual(fit(4000,6000,1600),{width:1067,height:1600});
  assert.deepEqual(fit(320,240,1600),{width:320,height:240});
});
test('photo headers recognize demo JPEGs', () => {
  const image = readFileSync(new URL('../demo/1015.jpg',import.meta.url));
  assert.deepEqual(photoHeader(image.buffer.slice(image.byteOffset,image.byteOffset+image.byteLength)),
    {width:900,height:611,orientation:1,type:'image/jpeg'});
});
test('JPEG EXIF orientation 6 swaps dimensions before decoding', () => {
  const image = buf([
    255,216,255,225,0,34, 69,120,105,102,0,0,
    73,73,42,0,8,0,0,0, 1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0,
    255,192,0,11,8,15,160,23,112,1,1,17,0,255,217
  ]);
  assert.deepEqual(photoHeader(image),{width:4000,height:6000,orientation:6,type:'image/jpeg'});
});
test('oversized and unsupported input is rejected before decoding', () => {
  const png = buf([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,39,16,0,0,39,16]);
  assert.throws(() => photoHeader(png),{code:'pixels'});
  assert.throws(() => photoHeader(buf([255,216,255,217])),{code:'unreadable'});
  assert.throws(() => photoHeader(buf([0,1,2,3])),{code:'unsupported'});
});
test('animated extended WebP is rejected', () => {
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF'),0);
  webp.set(new TextEncoder().encode('WEBPVP8X'),8);
  webp[20] = 2;
  assert.throws(() => photoHeader(webp.buffer),{code:'animated'});
});
test('votes change rankings; ties conserve rating; undo restores order', () => {
  const photos = ['a','b','c'].map(id => ({id}));
  const votes = [{a:'a',b:'b',outcome:'b'},{a:'b',b:'c',outcome:'tie'}];
  const ranked = standings(photos,votes).ranked;
  assert.equal(ranked[0].photo.id,'b');
  assert.equal(ranked.find(x => x.photo.id === 'a').rating,984);
  assert.equal(ranked.reduce((n,r) => n + r.rating,0),3000);
  assert.equal(ranked.find(x => x.photo.id === 'c').ties,1);
  assert.deepEqual(standings(photos,[]).ranked.map(x => x.photo.id),['a','b','c']);
});
test('matchmaking stays balanced and does not immediately repeat a pair', () => {
  const photos = Array.from({length:17},(_,i) => ({id:String(i)})), votes = [];
  let seed = 117;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 34; i++) {
    const old = votes.at(-1), pair = nextPair(photos,votes,old,random);
    assert.notEqual(pair.a,pair.b);
    if (old) assert.notEqual(pairKey(pair.a,pair.b),pairKey(old.a,old.b));
    votes.push({...pair,outcome:'a'});
  }
  const counts = standings(photos,votes).ranked.map(row => row.played);
  assert.ok(Math.min(...counts) >= 3);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2);
  assert.equal(nextPair(photos.slice(0,1),[],null),null);
});
test('ZIP stores UTF-8 names, CRCs and entry offsets for multiple photos', async () => {
  const sample = new TextEncoder().encode('123456789');
  assert.equal(crc32(sample),0xcbf43926);
  const entries = [{name:'01-山.jpg',blob:new Blob([sample])},{name:'02-valley.jpg',blob:new Blob(['copy'])}];
  const bytes = new Uint8Array(await (await makeZip(entries)).arrayBuffer());
  const view = new DataView(bytes.buffer), end = bytes.length - 22;
  assert.equal(view.getUint32(end,true),0x06054b50);
  assert.equal(view.getUint16(end + 10,true),2);
  let at = view.getUint32(end + 16,true);
  for (const {name,blob} of entries) {
    assert.equal(view.getUint32(at,true),0x02014b50);
    assert.equal(view.getUint16(at + 8,true),0x800);
    const len = view.getUint16(at + 28,true), offset = view.getUint32(at + 42,true);
    assert.equal(new TextDecoder().decode(bytes.slice(at+46,at+46+len)),name);
    assert.equal(view.getUint32(offset,true),0x04034b50);
    assert.equal(view.getUint32(offset + 18,true),blob.size);
    assert.equal(view.getUint32(at + 16,true),crc32(new Uint8Array(await blob.arrayBuffer())));
    at += 46 + len;
  }
  assert.equal(at,end);
  assert.equal(exportName('..\\山:谷.JPG'),'_山_谷');
});
test('interpolated comparison progress works in both languages', () => {
  assert.equal(translate('zh','rounds',{n:3,total:12}),'第 3 / 12 轮');
  assert.equal(translate('en','rounds',{n:3,total:12}),'Round 3 / 12');
});
