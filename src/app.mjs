import {LIMITS, PhotoError, nextPair, standings, exportName} from './core.mjs';
import {processPhoto} from './image.mjs';
import {makeZip} from './zip.mjs';
import {translate} from './i18n.mjs';

const $ = id => document.getElementById(id);
const MAX_VOTES = 1000;
const session = {photos:[], votes:[], goal:0, demo:false};
const previewUrls = new Map();
let usedUrls = new Set();
let locale = 'zh', view = 'duel', pair = null, db, ready = false;
let importing = false, cancelled = false, exporting = false, saved = true;
let importIndex = 0, importTotal = 0, importCount = 0, errors = [];
let inspectUrl, pendingConfirm, toastTimer;
try { if (localStorage.getItem('frame-room-language') === 'en') locale = 'en'; } catch {}
const t = (key, values) => translate(locale, key, values);
const byId = id => session.photos.find(photo => photo.id === id);
const rank = () => standings(session.photos, session.votes).ranked;
const picks = () => rank().filter(row => row.photo.picked);
const fmt = bytes => bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
const serial = n => String(n).padStart(2, '0');
const initialGoal = () => Math.min(MAX_VOTES, session.photos.length * 2);

function node(tag, cls, label) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (label !== undefined) e.textContent = label;
  return e;
}
function button(label, action, cls = 'secondary', attrs = {}, disabled = false) {
  const e = node('button', cls, label);
  e.type = 'button'; e.dataset.action = action; e.disabled = disabled;
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  return e;
}
function toast(key, values) {
  clearTimeout(toastTimer);
  $('toast').textContent = t(key, values);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 3900);
}
function applyCopy() {
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
  document.title = 'Frame Room · ' + t('brand');
  $('language').value = locale;
  document.querySelectorAll('[data-copy]').forEach(e => { e.textContent = t(e.dataset.copy); });
  document.querySelectorAll('[data-label]').forEach(e => { e.setAttribute('aria-label', t(e.dataset.label)); });
  $('help-keys').replaceChildren(shortcuts());
}
function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Storage unavailable'));
    tx.onerror = () => reject(tx.error);
  });
}
async function restore() {
  const request = indexedDB.open('frame-room-v1', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('photos', {keyPath:'id'});
    request.result.createObjectStore('session');
  };
  db = await requestResult(request);
  db.onversionchange = () => { db.close(); db = null; saved = false; };
  const tx = db.transaction(['photos', 'session']);
  const [photos, meta] = await Promise.all([
    requestResult(tx.objectStore('photos').getAll()), requestResult(tx.objectStore('session').get('current'))
  ]);
  if (!meta) return false;
  session.photos = photos.sort((a,b) => a.order - b.order);
  const ids = new Set(photos.map(p => p.id));
  session.votes = (meta.votes || []).filter(v => ids.has(v.a) && ids.has(v.b)).slice(0, MAX_VOTES);
  session.goal = Math.min(MAX_VOTES, Math.max(meta.goal || 0, initialGoal()));
  pair = nextPair(session.photos, session.votes, session.votes.at(-1));
  return true;
}
async function save({put = [], remove = [], clear = false} = {}) {
  if (session.demo) return;
  if (!db) { saved = false; return; }
  try {
    const tx = db.transaction(['photos','session'], 'readwrite'), store = tx.objectStore('photos');
    const done = transactionDone(tx);
    if (clear) store.clear();
    for (const id of remove) store.delete(id);
    for (const photo of put) store.put(photo);
    tx.objectStore('session').put({votes:session.votes, goal:session.goal}, 'current');
    await done;
  } catch {
    if (saved) toast('unsaved');
    saved = false;
  }
}

function photoUrl(photo, thumbnail = false) {
  const key = photo.id + (thumbnail ? ':thumb' : ':preview');
  usedUrls.add(key);
  if (!previewUrls.has(key)) previewUrls.set(key, URL.createObjectURL(thumbnail ? photo.thumbnail : photo.blob));
  return previewUrls.get(key);
}
function releaseUnused() {
  for (const [key,url] of previewUrls) {
    if (!usedUrls.has(key)) { URL.revokeObjectURL(url); previewUrls.delete(key); }
  }
}
function showPhoto(photo, label, thumb = false) {
  const img = node('img');
  img.src = photoUrl(photo, thumb);
  img.alt = label; img.decoding = 'async';
  if (thumb) img.loading = 'lazy';
  return img;
}

function renderSidebar() {
  $('session-name').textContent = t(session.demo ? 'sample' : 'personal');
  $('session-tag').textContent = t(session.demo ? 'demoTag' : 'privateTag');
  $('nav-count').textContent = serial(session.photos.length);
  for (const b of $('views').querySelectorAll('button')) {
    if (b.dataset.view === view) b.setAttribute('aria-current','page');
    else b.removeAttribute('aria-current');
  }
  const total = session.photos.reduce((n,p) => n + p.originalBytes, 0);
  const compressed = session.photos.reduce((n,p) => n + p.bytes, 0);
  const metrics = [
    ['count', serial(session.photos.length)], ['votes', serial(session.votes.length)],
    ['picks', serial(session.photos.filter(p => p.picked).length)],
    ['sourceBytes', fmt(total)], ['proxyBytes', fmt(compressed)]
  ];
  $('stats').replaceChildren(...metrics.map(([label, value], i) => {
    const e = node('div','metric' + (i === 3 ? ' bytes' : ''));
    e.append(node('span','',t(label)), node('strong','',value));
    return e;
  }));
  $('clear-button').disabled = !session.photos.length || importing || exporting;
  $('import-button').disabled = !ready || importing || exporting;
}
function heading(title, hint) {
  const box = node('div','screen-head'), text = node('div','screen-title');
  text.append(node('h1','',t(title)), node('p','',t(hint)));
  box.append(text); return box;
}
function shortcuts() {
  const list = node('div','shortcuts');
  for (const [key, label] of [['1','keyLeft'],['2','keyRight'],['=','keyTie'],['→','keySkip'],['Ctrl/⌘ Z','keyUndo']]) {
    const item = node('span'); item.append(node('kbd','',key), t(label)); list.append(item);
  }
  return list;
}
function emptyPanel(title, hint, values) {
  const panel = node('div','empty');
  panel.append(node('div','empty-symbol','◫'), node('h2','',t(title)), node('p','',t(hint,values)));
  return panel;
}
function importEmpty() {
  const panel = emptyPanel(session.photos.length === 1 ? 'tooFew' : 'empty', 'emptyHint');
  const actions = node('div','empty-actions');
  actions.append(button(t('import'),'import','primary',{},importing));
  if (!session.photos.length) actions.append(button(t('loadDemo'),'demo','secondary',{},importing));
  panel.append(actions, node('small','sheet-note',t('formats')));
  return panel;
}
function duelCard(photo, side) {
  const left = side === 'a', label = t(left ? 'leftPhoto' : 'rightPhoto');
  const card = node('article','duel-card');
  const frame = button('', 'inspect','frame',{'data-id':photo.id,'data-side':side, 'aria-label':t('inspect') + ': ' + label});
  const index = node('span','frame-index',left ? 'A' : 'B'), zoom = node('span','zoom','⤢');
  index.setAttribute('aria-hidden','true'); zoom.setAttribute('aria-hidden','true');
  frame.append(showPhoto(photo,label), index, zoom);
  const choose = button('', 'vote','choose',{'data-side':side},importing);
  choose.append(node('kbd','',left ? '1' : '2'), t(left ? 'chooseLeft' : 'chooseRight'));
  card.append(frame,choose); return card;
}
function renderDuel() {
  const head = heading('duel','duelHint');
  if (session.photos.length < 2) return [head,importEmpty()];
  const complete = session.votes.length >= session.goal;
  const round = node('div','round');
  round.append(node('strong','', complete ? t('doneRounds',{n:session.votes.length}) : t('rounds',{n:session.votes.length + 1,total:session.goal})));
  const meter = node('progress'); meter.max = session.goal || 1; meter.value = session.votes.length;
  meter.setAttribute('aria-label',t('votes')); round.append(meter); head.append(round);
  if (complete) {
    const panel = emptyPanel('finished','finishedHint',{n:session.votes.length});
    const actions = node('div','empty-actions');
    actions.append(button(t('review'),'view','primary',{'data-view':'rank'}),
      button(t('keepGoing'),'continue','secondary',{},importing || session.votes.length >= MAX_VOTES),
      button(t('undo'),'undo','secondary',{},importing));
    panel.append(actions); return [head,panel];
  }
  if (!pair || !byId(pair.a) || !byId(pair.b)) pair = nextPair(session.photos, session.votes, null);
  const grid = node('div','duel-pair');
  grid.append(duelCard(byId(pair.a),'a'), duelCard(byId(pair.b),'b'));
  const actions = node('div','duel-actions');
  actions.append(button('↶  ' + t('undo'),'undo','secondary',{},importing || !session.votes.length),
    button(t('tie'),'vote','secondary',{'data-side':'tie'},importing),
    button(t('skip') + '  →','skip','secondary',{},importing || session.photos.length < 3),
    button(t('review'),'view','quiet',{'data-view':'rank'},!session.votes.length));
  const foot = node('div','screen-foot'); foot.append(shortcuts(),node('span','',t('peek')));
  return [head,grid,actions,foot];
}
function fileRow(row, index, ranked) {
  const {photo, played, wins, rating} = row;
  const item = node('article','file-row');
  const order = node('div','position' + (ranked && played && index < 3 ? ' top' : ''), ranked && !played ? '—' : serial(index + 1));
  const thumb = button('', 'inspect','file-thumb',{'data-id':photo.id,'aria-label':t('inspect') + ': ' + photo.name});
  thumb.append(showPhoto(photo, '', true));
  const name = node('div','file-name');
  const title = node('strong','',photo.name); title.title = photo.name;
  name.append(title, node('small','',photo.originalWidth + ' × ' + photo.originalHeight + ' → ' + photo.width + ' × ' + photo.height));
  const detail = node('div','file-detail');
  if (ranked) {
    detail.append(node('b','',played ? Math.round(rating) + ' ' + t('score') : t('unplayed')));
    if (played) detail.append(node('small','',t('played',{n:played,w:wins})));
  } else {
    detail.append(node('span','',fmt(photo.originalBytes) + ' → '), node('b','',fmt(photo.bytes)));
    const reduction = Math.round((1 - photo.bytes / photo.originalBytes) * 100);
    detail.append(node('small','',t(reduction > 0 ? 'smaller' : reduction < 0 ? 'larger' : 'sameSize',{n:Math.abs(reduction)})));
  }
  const actions = node('div','file-actions');
  const pickLabel = t(photo.picked ? 'unpicked' : 'pick') + ': ' + photo.name;
  actions.append(button(photo.picked ? '★' : '☆', 'pick', 'icon-button pick', {
    'data-id':photo.id, 'aria-pressed':String(!!photo.picked), 'aria-label':pickLabel, title:pickLabel
  }, importing || exporting));
  const other = t(ranked ? 'download' : 'remove') + ': ' + photo.name;
  actions.append(button(ranked ? '↓' : '×', ranked ? 'download' : 'remove', 'icon-button',
    {'data-id':photo.id, 'aria-label':other, title:other},importing || exporting));
  item.append(order,thumb,name,detail,actions); return item;
}
function renderList(ranked) {
  const head = heading(ranked ? 'rank' : 'library',ranked ? 'rankHint' : 'libraryHint');
  if (!session.photos.length) return [head,importEmpty()];
  const rows = rank();
  if (!ranked) rows.sort((a,b) => a.index - b.index);
  const list = node('div','file-list'); list.append(...rows.map((row,i) => fileRow(row,i,ranked)));
  if (!ranked) return [head,list];
  const actions = node('div','exports'), count = Math.min(5,rows.filter(row => row.played).length);
  const disabled = importing || exporting;
  const noPicks = !picks().length;
  actions.append(button(t('top',{n:count || 5}),'top','secondary',{},disabled || !count),
    button(t('zip'),'zip','primary',{},disabled || noPicks),
    button(t('sheet'),'sheet','secondary',{},disabled || noPicks),
    button(t('rankingFile'),'csv','secondary',{},disabled || !session.votes.length));
  return [head,actions,list,node('p','section-note',t('provisional'))];
}
function renderImport() {
  const status = $('import-status'), stop = $('cancel-import'), meter = $('import-progress');
  status.hidden = !importing && !errors.length;
  stop.hidden = !importing;
  stop.disabled = cancelled;
  meter.hidden = !importing;
  meter.max = importTotal || 1; meter.value = Math.max(0,importIndex - 1);
  $('import-label').textContent = importing ? (cancelled ? t('stopping') : t('importing',{n:importIndex,total:importTotal})) :
    t('importResult',{n:importCount,m:errors.length});
  status.querySelector('.error-details')?.remove();
  if (errors.length && !importing) {
    const details = node('details','error-details');
    details.append(node('summary','',t('failedFiles')));
    const list = node('ul','import-errors');
    for (const error of errors) list.append(node('li','',error.name + ' — ' + t(error.code)));
    details.append(list); status.append(details);
  }
}
function render() {
  renderSidebar(); renderImport();
  usedUrls = new Set();
  let contents;
  if (!ready) contents = [node('p','section-note',t('loading'))];
  else contents = view === 'duel' ? renderDuel() : renderList(view === 'rank');
  $('screen').replaceChildren(...contents);
  if (!saved && !session.demo) $('screen').append(node('p','section-note',t('unsaved')));
  releaseUnused();
}

async function workerPhoto(file) {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return processPhoto(file);
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], {type:'text/javascript'}));
  let worker, timer;
  try {
    return await new Promise((resolve, reject) => {
      try { worker = new Worker(url); } catch (error) { reject(error); return; }
      timer = setTimeout(() => reject(new PhotoError('unreadable')), 45_000);
      worker.onmessage = ({data}) => data.error ? reject(new PhotoError(data.error)) : resolve(data.photo);
      worker.onerror = reject;
      worker.postMessage({id:0,file});
    });
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    worker?.terminate();
    return processPhoto(file);
  } finally {
    clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(url);
  }
}

async function importPhotos(files, demo = false) {
  if (importing || exporting) { toast('importBusy'); return; }
  if (!files.length) return;
  importing = true; cancelled = false; importCount = 0; errors = [];
  importIndex = 1; importTotal = files.length;
  render();
  let order = session.photos.reduce((n,p) => Math.max(n,p.order),0);
  let occupied = session.photos.reduce((n,p) => n + p.bytes + p.thumbnail.size,0);
  for (const file of files) {
    if (cancelled) break;
    const replaceDemo = !demo && session.demo;
    if (!replaceDemo && session.photos.length >= LIMITS.count) {
      errors.push({name:file.name,code:'maximum'}); break;
    }
    const key = [file.name,file.size,file.lastModified].join('|');
    try {
      if (!replaceDemo && session.photos.some(photo => photo.key === key)) throw new PhotoError('duplicate');
      const result = await workerPhoto(file);
      if ((replaceDemo ? 0 : occupied) + result.bytes + result.thumbnail.size > LIMITS.shelf) throw new PhotoError('shelf');
      if (replaceDemo) {
        session.photos = []; session.votes = []; session.goal = 0; pair = null;
        session.demo = false; occupied = 0; order = 0;
      }
      const photo = {...result, key, id:makeId(), picked:false, order:++order};
      session.photos.push(photo);
      occupied += photo.bytes + photo.thumbnail.size;
      session.goal = Math.min(MAX_VOTES, Math.max(session.goal, initialGoal(), session.votes.length + session.photos.length));
      importCount++;
      await save({put:[photo]});
    } catch (error) {
      errors.push({name:file.name, code:error.code || 'unreadable'});
    }
    importIndex = Math.min(importTotal, importIndex + 1);
    renderImport();
  }
  importing = false;
  if (importCount) { pair = nextPair(session.photos,session.votes,pair); view = 'duel'; }
  render();
  if (!demo) toast(errors.length ? 'importResult' : 'imported',{n:importCount,m:errors.length});
}
async function loadDemo() {
  if (session.photos.length || importing) return;
  session.demo = true;
  importing = true; cancelled = false; importIndex = 1; importTotal = DEMO.length;
  render();
  const results = await Promise.allSettled(DEMO.map(async sample => {
    let bytes;
    if (sample.data) bytes = Uint8Array.from(atob(sample.data), c => c.charCodeAt(0));
    else {
      const response = await fetch('./demo/' + encodeURIComponent(sample.name), {signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('Demo photo unavailable');
      bytes = await response.blob();
    }
    return new File([bytes], sample.name, {type:'image/jpeg',lastModified:0});
  }));
  importing = false;
  if (cancelled) { session.demo = false; render(); return; }
  const files = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!files.length) { session.demo = false; render(); toast('demoUnavailable'); return; }
  await importPhotos(files,true);
}

function pickPair(outcome) {
  if (view !== 'duel' || importing || !pair || session.votes.length >= session.goal) return;
  session.votes.push({...pair,outcome});
  pair = nextPair(session.photos,session.votes,pair);
  void save(); render(); toast('voted');
}
function undo() {
  if (importing || !session.votes.length) return;
  const previous = session.votes.pop();
  pair = {a:previous.a,b:previous.b}; view = 'duel';
  void save(); render(); toast('undone');
}
function skip() {
  if (view !== 'duel' || importing || !pair || session.photos.length < 3 || session.votes.length >= session.goal) return;
  pair = nextPair(session.photos,session.votes,pair);
  render(); toast('skipped');
}
function inspect(photo, side) {
  if (!photo) return;
  const blind = side === 'a' || side === 'b';
  const label = blind ? t(side === 'a' ? 'leftPhoto' : 'rightPhoto') : photo.name;
  if (inspectUrl) URL.revokeObjectURL(inspectUrl);
  inspectUrl = URL.createObjectURL(photo.blob);
  $('inspect-title').textContent = label;
  $('inspect-image').src = inspectUrl; $('inspect-image').alt = label;
  $('inspect-caption').textContent = blind ? t('preview') : t('preview') + ' · ' + photo.width + ' × ' + photo.height + ' · ' + fmt(photo.bytes);
  $('inspect-dialog').showModal();
}
function confirmAction(title,text,run) {
  $('confirm-title').textContent = t(title); $('confirm-text').textContent = t(text);
  pendingConfirm = run; $('confirm-dialog').showModal();
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = node('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}
function fileName(row,index) {
  return serial(index + 1) + '-' + exportName(row.photo.name) + '.jpg';
}
function csvField(value) {
  let s = String(value);
  if (/^\s*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"','""') + '"';
}
async function contactSheet(rows) {
  const cols = Math.min(5, rows.length), pad = 26, gap = 10, cell = 330, tile = 220, step = tile + 46;
  const width = pad * 2 + cols * cell + (cols - 1) * gap;
  const height = 98 + Math.ceil(rows.length / cols) * step + pad;
  const canvas = canvasOf(width,height);
  try {
    const ctx = canvas.getContext('2d',{alpha:false});
    ctx.fillStyle = '#ecebe3'; ctx.fillRect(0,0,width,height);
    ctx.fillStyle = '#232822'; ctx.font = '600 29px sans-serif';
    ctx.fillText('Frame Room',pad,44);
    ctx.fillStyle = '#59645b'; ctx.font = '14px sans-serif';
    ctx.fillText(t('sheet').replace(/^导出\s*|^Export\s+/,''),pad,67);
    for (let i = 0; i < rows.length; i++) {
      const {photo} = rows[i], x = pad + i % cols * (cell + gap), y = 98 + Math.floor(i / cols) * step;
      const bitmap = await createImageBitmap(photo.thumbnail);
      try {
        const scale = Math.min(cell / bitmap.width, tile / bitmap.height);
        const w = bitmap.width * scale, h = bitmap.height * scale;
        ctx.fillStyle = '#222723'; ctx.fillRect(x,y,cell,tile);
        ctx.drawImage(bitmap,x + (cell - w) / 2,y + (tile - h) / 2,w,h);
      } finally { bitmap.close(); }
      ctx.fillStyle = '#222723'; ctx.font = '14px sans-serif';
      const line = serial(i + 1) + '   ' + photo.name;
      let label = line;
      while (label.length > 1 && ctx.measureText(label + '…').width > cell) label = label.slice(0,-1);
      ctx.fillText(label + (label === line ? '' : '…'),x,y + tile + 23);
    }
    return await jpegOf(canvas,.9);
  } finally { canvas.width = 1; canvas.height = 1; }
}
async function exportPicks(kind) {
  if (exporting || importing) return;
  const rows = picks();
  if (!rows.length) { toast('pickFirst'); return; }
  exporting = true; render(); toast('exporting');
  try {
    if (kind === 'zip') {
      const archive = await makeZip(rows.map((row,i) => ({name:fileName(row,i),blob:row.photo.blob})));
      download(archive,'frame-room-picks.zip');
    } else {
      download(await contactSheet(rows),'frame-room-contact-sheet.jpg');
    }
    toast('exported');
  } catch { toast('exportFailed'); }
  finally { exporting = false; render(); }
}

$('file-input').addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = ''; void importPhotos(files);
});
$('language').addEventListener('change', e => {
  locale = e.target.value;
  try { localStorage.setItem('frame-room-language',locale); } catch {}
  applyCopy(); render();
});
$('inspect-dialog').addEventListener('close', () => {
  if (inspectUrl) URL.revokeObjectURL(inspectUrl);
  inspectUrl = null; $('inspect-image').removeAttribute('src');
});
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action, photo = byId(target.dataset.id);
  if (action === 'import') $('file-input').click();
  if (action === 'demo') void loadDemo();
  if (action === 'help') $('help-dialog').showModal();
  if (action === 'close') target.closest('dialog').close();
  if (action === 'view') { view = target.dataset.view; render(); }
  if (action === 'inspect') inspect(photo,target.dataset.side);
  if (action === 'vote') pickPair(target.dataset.side);
  if (action === 'skip') skip();
  if (action === 'undo') undo();
  if (action === 'cancel') { cancelled = true; renderImport(); }
  if (action === 'continue') {
    session.goal = Math.min(MAX_VOTES,session.votes.length + session.photos.length);
    pair = nextPair(session.photos,session.votes,pair); void save(); render();
  }
  if (action === 'pick' && photo) { photo.picked = !photo.picked; void save({put:[photo]}); render(); }
  if (action === 'top') {
    const top = rank().filter(row => row.played).slice(0,5).map(row => row.photo);
    for (const p of top) p.picked = true;
    void save({put:top}); render();
  }
  if (action === 'download' && photo) { download(photo.blob,exportName(photo.name) + '-preview.jpg'); toast('exported'); }
  if (action === 'zip' || action === 'sheet') void exportPicks(action);
  if (action === 'csv') {
    const rows = rank().map(({photo,rating,played,wins,ties},i) =>
      [played ? i + 1 : '',photo.name,played ? Math.round(rating) : '',played,wins,ties,photo.picked ? 1 : 0,photo.originalBytes,photo.bytes]);
    const head = 'rank,filename,rating,decisions,wins,ties,starred,original_bytes,preview_bytes';
    const csv = head + '\r\n' + rows.map(row => row.map(csvField).join(',')).join('\r\n');
    download(new Blob(['\uFEFF',csv],{type:'text/csv;charset=utf-8'}),'frame-room-ranking.csv'); toast('exported');
  }
  if (action === 'remove' && photo) confirmAction('removeTitle','removeText', () => {
    session.photos = session.photos.filter(p => p !== photo);
    session.votes = session.votes.filter(v => v.a !== photo.id && v.b !== photo.id);
    session.goal = Math.max(session.votes.length,initialGoal());
    pair = nextPair(session.photos,session.votes,pair); void save({remove:[photo.id]}); render();
  });
  if (action === 'clear') confirmAction('clearTitle','clearText', () => {
    session.photos = []; session.votes = []; session.goal = 0; session.demo = false;
    errors = []; pair = null; view = 'duel'; void save({clear:true}); render();
  });
  if (action === 'confirm') {
    $('confirm-dialog').close();
    const run = pendingConfirm; pendingConfirm = null; run?.();
  }
});
document.addEventListener('keydown', event => {
  if (view !== 'duel' || event.repeat || document.querySelector('dialog[open]') ||
      event.target.matches?.('input,select,textarea,[contenteditable]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const choice = {'1':'a','2':'b','=':'tie'}[event.key];
  if (choice && pair) { event.preventDefault(); pickPair(choice); }
  if (event.key === 'ArrowRight' && pair) { event.preventDefault(); skip(); }
});
let dragDepth = 0;
const draggedFiles = event => event.dataTransfer?.types.includes('Files');
document.addEventListener('dragenter', event => {
  if (!draggedFiles(event)) return;
  event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', event => { if (draggedFiles(event)) event.preventDefault(); });
document.addEventListener('dragleave', event => {
  if (!draggedFiles(event)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; }
});
document.addEventListener('drop', event => {
  if (!draggedFiles(event)) return;
  event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  if (ready) void importPhotos([...event.dataTransfer.files]);
});

for (const photo of DEMO) {
  const li = node('li'), a = node('a','',photo.author);
  a.href = photo.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); $('credits-list').append(li);
}
applyCopy(); render();
let restored = false;
try { restored = await restore(); } catch { saved = false; }
ready = true; render();
if (!restored) await loadDemo();
