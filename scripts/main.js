// METIS — UI glue: boot, login + charter, add point, point panel (tabs), add-item form, viewers, sound.
import { initI18n, t, tr, getLang, setLang, applyI18n } from './i18n.js';
import { createBackend } from './backend.js';
import { MetisMap } from './map.js';
import { uploadMedia, videoEmbed } from './upload.js';
import { Auraliser, loadBuffer, audioContext } from './audio.js';
import { analyseIR, cleanImpulse } from './irAnalysis.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStaff = u => u && (u.role === 'instructor' || u.role === 'admin');

const TABS = { gallery: ['photo', 'video'], pano: ['pano'], sound: ['ir', 'audio'], texts: ['text'] };
const ACCEPT = { photo: 'image/*', pano: 'image/jpeg,image/png', video: 'video/*', audio: 'audio/*', ir: '.wav,audio/wav,audio/x-wav' };
const IR_FORMATS = ['mono', 'stereo', 'binaural', 'foa-ambix', 'foa-fuma'];
const IR_METHODS = ['clap', 'balloon', 'sweep', 'other'];

const state = { config: null, backend: null, map: null, user: null, adding: false, point: null, items: [], unwatchItems: null, tab: 'gallery', pano: null, auraliser: null, yawLoop: null };

boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="fatal">${esc(e.message)}</p>`); });

async function boot() {
  state.config = await (await fetch('config.json')).json();
  await initI18n(state.config.project.defaultLang);
  state.backend = await createBackend(state.config);
  renderHeader();

  state.map = new MetisMap($('#map'), state.config, {
    onPointClick: openPoint,
    onMapClick: coords => state.adding && createPointAt(coords),
  });

  state.backend.onUser(async user => {
    state.user = user;
    renderHeader();
    if (user && !user.charterAcceptedAt) await showCharter();
    startWatching();
  });
}

async function startWatching() {
  const project = await state.backend.getProject();
  if (project === null) { $('#notice').textContent = t('classOnly'); $('#notice').hidden = false; return; }
  $('#notice').hidden = true;
  state.unwatchPoints?.();
  state.unwatchPoints = state.backend.watchPoints(pts => state.map.setPoints(pts), err => console.warn(err));
}

// ---------- header ----------
function renderHeader() {
  const c = state.config, u = state.user;
  $('#title').textContent = tr(c.project.title);
  $('#subtitle').textContent = tr(c.project.subtitle);
  const current = state.map?.floor ?? c.floors[0]?.id;
  $('#floors').hidden = c.floors.length < 2;
  $('#floors').innerHTML = c.floors.map(f => `<button data-floor="${esc(f.id)}" class="${f.id === current ? 'on' : ''}">${esc(tr(f.label))}</button>`).join('');
  $('#floors').querySelectorAll('[data-floor]').forEach(b => (b.onclick = () => { state.map.setFloor(b.dataset.floor); renderHeader(); }));
  $('#lang').textContent = getLang() === 'fr' ? 'EN' : 'FR';
  $('#lang').onclick = () => { setLang(getLang() === 'fr' ? 'en' : 'fr'); applyI18n(); renderHeader(); if (state.point) renderPanel(); };
  $('#add').hidden = !u || state.backend.readOnly;
  $('#add').onclick = () => toggleAdding(!state.adding);
  $('#auth').hidden = state.backend.readOnly;
  $('#auth').classList.toggle('avatar', !!u);
  $('#auth').innerHTML = u ? `<span class="initials">${esc(u.displayName.slice(0, 2).toUpperCase())}</span>` : esc(t('login'));
  $('#auth').title = u ? `${u.displayName} · ${t('logout')}` : '';
  $('#auth').onclick = () => (u ? state.backend.logout() : showLogin());
  applyI18n();
}

function toggleAdding(on) {
  state.adding = on;
  state.map.setCursorMode(on);
  $('#add').classList.toggle('active', on);
  document.body.classList.toggle('adding', on);
  $('#hint').hidden = !on;
  $('#hint').textContent = t('addPointHint');
}

// ---------- dialogs ----------
function dialog(html, onSubmit) {
  const d = $('#dialog');
  d.innerHTML = `<form method="dialog">${html}</form>`;
  const form = d.querySelector('form');
  form.querySelector('[data-cancel]')?.addEventListener('click', () => d.close());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try { if ((await onSubmit(new FormData(form), form)) !== false) d.close(); }
    catch (err) { console.error(err); form.querySelector('.err').textContent = err.message; }
  });
  d.showModal();
  return form;
}

function showLogin() {
  dialog(`
    <h2>${t('login')}</h2>
    <label>${t('username')}<input name="u" autocomplete="username" required></label>
    <label>${t('password')}<input name="p" type="password" autocomplete="current-password" required></label>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('login')}</button></menu>`,
    async fd => {
      try { await state.backend.login(fd.get('u'), fd.get('p')); }
      catch { throw new Error(t('loginError')); }
    });
}

async function showCharter() {
  const path = state.config.project.charterPath.replace('{lang}', getLang());
  const text = await fetch(path).then(r => (r.ok ? r.text() : '')).catch(() => '');
  return new Promise(resolve => {
    dialog(`
      <h2>${t('charterTitle')}</h2>
      <div class="charter">${esc(text).replace(/\n\n/g, '</p><p>').replace(/^/, '<p>')}</p></div>
      <label class="check"><input type="checkbox" required> ${t('charterAccept')}</label>
      <p class="err"></p>
      <menu><button>${t('save')}</button></menu>`,
      async () => { await state.backend.acceptCharter(); resolve(); });
    $('#dialog').addEventListener('cancel', e => e.preventDefault(), { once: true }); // charter is mandatory
  });
}

// ---------- points ----------
function createPointAt(coords) {
  toggleAdding(false);
  const geo = state.map.mode === 'geo';
  const form = dialog(`
    <h2>${t('addPoint')}</h2>
    <label>${t('pointName')}<input name="name" required maxlength="80"></label>
    ${geo ? `<button type="button" data-gps>${t('useGps')}</button><small class="gps"></small>` : ''}
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async fd => {
      const id = await state.backend.addPoint({ ...coords, name: fd.get('name').trim() });
      openPoint({ id, name: fd.get('name').trim(), ...coords });
    });
  form.querySelector('[data-gps]')?.addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      p => { coords.lat = p.coords.latitude; coords.lng = p.coords.longitude; form.querySelector('.gps').textContent = `±${Math.round(p.coords.accuracy)} m`; },
      err => (form.querySelector('.gps').textContent = err.message),
      { enableHighAccuracy: true, timeout: 15000 });
  });
}

function openPoint(point) {
  state.point = point;
  state.unwatchItems?.();
  state.unwatchItems = state.backend.watchItems(point.id, items => { state.items = items; renderPanel(); });
  $('#panel').hidden = false;
  document.body.classList.add('panel-open');
  renderPanel();
}

function closePoint() {
  state.unwatchItems?.(); state.unwatchItems = null;
  state.point = null; teardownViewers();
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
}

// ---------- panel ----------
function visibleItems() {
  return state.items.filter(it => !it.hidden || isStaff(state.user) || it.author?.uid === state.user?.uid);
}

function renderPanel() {
  if (!state.point) return;
  teardownViewers();
  const items = visibleItems().filter(it => TABS[state.tab].includes(it.type));
  $('#panel').innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header>
      <div><p class="kicker">${visibleItems().length} ${t('itemsN')} · ${new Set(visibleItems().map(it => it.author?.uid)).size} ${t('contributors')}</p><h2>${esc(state.point.name)}</h2></div>
      <button class="close icon" aria-label="close"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </header>
    <nav class="tabs">${Object.keys(TABS).map(k => {
      const n = visibleItems().filter(it => TABS[k].includes(it.type)).length;
      return `<button data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${t('tab' + k[0].toUpperCase() + k.slice(1))}${n ? `<span class="count">${n}</span>` : ''}</button>`;
    }).join('')}</nav>
    ${state.user && !state.backend.readOnly ? `<button class="add-item">+ ${t('addItem')}</button>` : ''}
    <section class="tab-body">${state.tab === 'sound' ? soundTab(items) : state.tab === 'pano' ? panoTab(items) : items.map(itemCard).join('') || `<p class="empty">${t('noItems')}</p>`}</section>`;

  $('#panel .close').onclick = closePoint;
  $('#panel').querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => { state.tab = b.dataset.tab; renderPanel(); }));
  $('#panel .add-item')?.addEventListener('click', () => showItemForm(TABS[state.tab][0]));
  $('#panel').querySelectorAll('[data-act]').forEach(b => (b.onclick = () => itemAction(b.dataset.act, b.dataset.id)));
  if (state.tab === 'pano') mountPano(items);
  if (state.tab === 'sound') mountSound(items);
}

function metaBlock(it) {
  const m = it.meta || {};
  const rows = ['description', 'users', 'intendedUse', 'unintendedUses', 'poetic', 'conditions', 'credit']
    .filter(k => m[k]).map(k => `<dt>${t('f_' + k)}</dt><dd>${esc(m[k])}</dd>`).join('');
  const tags = (m.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('');
  return rows || tags ? `<details><summary>${t('f_description')}</summary><dl>${rows}</dl>${tags}</details>` : '';
}

function actions(it) {
  const u = state.user;
  if (!u || state.backend.readOnly) return '';
  const own = it.author?.uid === u.uid;
  return `<div class="actions">
    ${isStaff(u) ? `<button data-act="${it.hidden ? 'unhide' : 'hide'}" data-id="${it.id}">${t(it.hidden ? 'unhide' : 'hide')}</button>` : ''}
    ${own || isStaff(u) ? `<button data-act="delete" data-id="${it.id}">${t('delete')}</button>` : ''}
  </div>`;
}

function itemCard(it) {
  const m = it.meta || {};
  let media = '';
  if (it.type === 'photo') media = `<a href="${esc(it.media.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(it.media.thumbUrl || it.media.url)}" alt="${esc(m.title)}"></a>`;
  if (it.type === 'video') media = it.videoLink
    ? (videoEmbed(it.videoLink) ? `<iframe src="${esc(videoEmbed(it.videoLink))}" allowfullscreen loading="lazy"></iframe>` : `<a href="${esc(it.videoLink)}" target="_blank" rel="noopener">${esc(it.videoLink)}</a>`)
    : `<video controls preload="none" poster="${esc(it.media.thumbUrl || '')}" src="${esc(it.media.url)}"></video>`;
  if (it.type === 'audio') media = `<audio controls preload="none" src="${esc(it.media.url)}"></audio>`;
  if (it.type === 'text') media = `<blockquote>${esc(m.text).replace(/\n/g, '<br>')}</blockquote>`;
  const date = m.capturedAt ? new Date(m.capturedAt).toLocaleString(getLang()) : '';
  return `<article class="item ${it.hidden ? 'is-hidden' : ''}">
    ${media}
    <h3>${esc(m.title)}</h3>
    <p class="byline">${t('by')} ${esc(it.author?.displayName)} · ${esc(date)}</p>
    ${metaBlock(it)}${actions(it)}
  </article>`;
}

async function itemAction(act, id) {
  const pid = state.point.id;
  if (act === 'delete' && confirm(t('confirmDelete'))) await state.backend.deleteItem(pid, id);
  if (act === 'hide') await state.backend.setHidden(pid, id, true);
  if (act === 'unhide') await state.backend.setHidden(pid, id, false);
}

// ---------- add item ----------
function showItemForm(type) {
  const opts = Object.keys(ACCEPT).concat('text').map(k => `<option value="${k}" ${k === type ? 'selected' : ''}>${t('type_' + k)}</option>`).join('');
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const field = (k, area) => `<label>${t('f_' + k)}${area ? `<textarea name="${k}" rows="2"></textarea>` : `<input name="${k}">`}</label>`;
  const form = dialog(`
    <h2>${t('addItem')}</h2>
    <label>${t('type')}<select name="type">${opts}</select></label>
    <div data-for="file"><label>${t('file')}<input name="file" type="file"></label></div>
    <div data-for="video"><label>${t('videoLink')}<input name="videoLink" type="url"></label></div>
    <div data-for="text">${field('text', true)}</div>
    <div data-for="ir">
      <label>${t('f_irFormat')}<select name="irFormat">${IR_FORMATS.map(f => `<option>${f}</option>`).join('')}</select></label>
      <label>${t('f_irMethod')}<select name="irMethod">${IR_METHODS.map(f => `<option>${f}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="irRaw"> ${t('rawClap')}</label>
      ${field('irSource')}${field('irReceiver')}
    </div>
    <div data-for="rot"><label>${t('f_rotation')}<input name="rotationDeg" type="number" value="0" step="1"></label></div>
    <div data-for="device">${field('device')}</div>
    ${field('title')}
    <label>${t('f_capturedAt')}<input name="capturedAt" type="datetime-local" value="${now}"></label>
    ${['description', 'users', 'intendedUse', 'unintendedUses', 'poetic', 'conditions'].map(k => field(k, true)).join('')}
    ${field('credit')}
    ${field('tags')}
    <progress hidden max="1" value="0"></progress>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async (fd, f) => {
      const type = fd.get('type');
      const tags = String(fd.get('tags') || '').split(',').map(s => s.trim()).filter(Boolean);
      const meta = { tags, capturedAt: fd.get('capturedAt') ? new Date(fd.get('capturedAt')).toISOString() : null };
      for (const k of ['title', 'description', 'users', 'intendedUse', 'unintendedUses', 'poetic', 'conditions', 'credit', 'text', 'device']) meta[k] = fd.get(k) || '';
      const item = { type, meta };
      const file = fd.get('file');
      const link = String(fd.get('videoLink') || '').trim();
      if (type === 'video' && link && !(file && file.size)) item.videoLink = link;
      else if (type !== 'text') {
        if (!file || !file.size) throw new Error(t('file') + ' ?');
        const bar = f.querySelector('progress'); bar.hidden = false;
        item.media = await uploadMedia(state.config, type, file, p => (bar.value = p));
      }
      if (type === 'ir') item.irInfo = {
        format: fd.get('irFormat'), method: fd.get('irMethod'), raw: fd.get('irRaw') === 'on',
        source: fd.get('irSource') || '', receiver: fd.get('irReceiver') || '', rotationDeg: Number(fd.get('rotationDeg')) || 0,
      };
      if (type === 'pano') item.panoInfo = { northOffsetDeg: Number(fd.get('rotationDeg')) || 0 };
      await state.backend.addItem(state.point.id, item);
    });

  const sync = () => {
    const ty = form.elements.type.value;
    const show = { file: ty !== 'text', video: ty === 'video', text: ty === 'text', ir: ty === 'ir', rot: ty === 'ir' || ty === 'pano', device: ty === 'audio' || ty === 'ir' };
    form.querySelectorAll('[data-for]').forEach(el => (el.hidden = !show[el.dataset.for]));
    if (ACCEPT[ty]) form.elements.file.accept = ACCEPT[ty];
  };
  form.elements.type.addEventListener('change', sync); sync();
}

// ---------- 360 ----------
function panoTab(items) {
  if (!items.length) return `<p class="empty">${t('noItems')}</p>`;
  return `<select class="pano-pick">${items.map((it, i) => `<option value="${i}">${esc(it.meta?.title || it.author?.displayName)}</option>`).join('')}</select>
    <div id="pano"></div>${items.map(it => itemCard({ ...it, type: 'pano-meta' })).join('')}`;
}

function mountPano(items, target = '#pano') {
  if (!items.length || !window.pannellum) return null;
  const show = i => {
    state.pano?.destroy();
    state.pano = window.pannellum.viewer($(target).id, {
      type: 'equirectangular', panorama: items[i].media.url, autoLoad: true, crossOrigin: 'anonymous',
      northOffset: items[i].panoInfo?.northOffsetDeg || 0, compass: false,
    });
  };
  show(0);
  $('.pano-pick')?.addEventListener('change', e => show(Number(e.target.value)));
  return state.pano;
}

// ---------- sound ----------
function soundTab(items) {
  const irs = items.filter(it => it.type === 'ir');
  const recs = items.filter(it => it.type === 'audio');
  const samples = state.config.audio.samples;
  const panos = visibleItems().filter(it => it.type === 'pano');
  return `
    ${irs.length ? `
    <div class="aur">
      <label>${t('chooseIR')}<select class="ir-pick">${irs.map((it, i) => `<option value="${i}">${esc(it.meta?.title || it.author?.displayName)} · ${esc(it.irInfo?.format)}</option>`).join('')}</select></label>
      <label>${t('chooseSource')}<select class="src-pick">${samples.map((s, i) => `<option value="${i}">${esc(tr(s.label))}</option>`).join('')}<option value="mic">${t('micSource')}</option></select></label>
      <p class="warn" hidden>${t('headphones')}</p>
      <button class="play">${t('play')}</button> <button class="stop">${t('stop')}</button>
      ${panos.length ? `<div id="pano-sound"></div>` : ''}
      <h3>${t('analysis')}</h3><canvas class="edc" width="600" height="220"></canvas><table class="params"></table>
    </div>` : ''}
    ${irs.map(itemCard).join('')}${recs.map(itemCard).join('')}
    ${!irs.length && !recs.length ? `<p class="empty">${t('noItems')}</p>` : ''}`;
}

function mountSound(items) {
  const irs = items.filter(it => it.type === 'ir');
  if (!irs.length) return;
  const panos = visibleItems().filter(it => it.type === 'pano');
  if (panos.length) {
    mountPano(panos, '#pano-sound');
    const loop = () => { if (state.pano && state.auraliser) state.auraliser.setOrientation(state.pano.getYaw(), state.pano.getPitch()); state.yawLoop = requestAnimationFrame(loop); };
    state.yawLoop = requestAnimationFrame(loop);
  }
  const panel = $('#panel');
  const srcPick = panel.querySelector('.src-pick');
  srcPick.onchange = () => (panel.querySelector('.warn').hidden = srcPick.value !== 'mic');
  let loaded = null;
  const loadIR = async () => {
    const it = irs[Number(panel.querySelector('.ir-pick').value)];
    let buf = await loadBuffer(it.media.url);
    if (it.irInfo?.raw) {
      const chans = cleanImpulse([...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c)), buf.sampleRate);
      buf = audioContext().createBuffer(chans.length, chans[0].length, buf.sampleRate);
      chans.forEach((c, i) => buf.copyToChannel(c, i));
    }
    state.auraliser ??= new Auraliser();
    state.auraliser.setIR(buf, it.irInfo?.format || 'mono', it.irInfo?.rotationDeg || 0);
    drawAnalysis(buf);
    loaded = it.id;
  };
  panel.querySelector('.ir-pick').onchange = loadIR;
  panel.querySelector('.play').onclick = async () => {
    const it = irs[Number(panel.querySelector('.ir-pick').value)];
    if (loaded !== it.id) await loadIR();
    if (srcPick.value === 'mic') await state.auraliser.startMic();
    else state.auraliser.playSample(await loadBuffer(state.config.audio.samples[Number(srcPick.value)].url));
  };
  panel.querySelector('.stop').onclick = () => state.auraliser?.stop();
  loadIR().catch(e => console.warn('IR load', e));
}

function drawAnalysis(buf) {
  const r = analyseIR(buf.getChannelData(0), buf.sampleRate);
  const cv = $('#panel .edc'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, n = r.edc.length, dbMin = -70;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = getComputedStyle(cv).color; g.lineWidth = 1.5; g.beginPath();
  for (let px = 0; px < W; px++) {
    const v = Math.max(dbMin, r.edc[Math.floor(px / W * (n - 1))]);
    const y = (v / dbMin) * H;
    px ? g.lineTo(px, y) : g.moveTo(px, y);
  }
  g.stroke();
  const f = (v, d, u) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + u);
  $('#panel .params').innerHTML = `
    <tr><th>EDT</th><td>${f(r.EDT, 2, ' s')}</td><th>T20</th><td>${f(r.T20, 2, ' s')}</td><th>T30</th><td>${f(r.T30, 2, ' s')}</td></tr>
    <tr><th>C50</th><td>${f(r.C50, 1, ' dB')}</td><th>C80</th><td>${f(r.C80, 1, ' dB')}</td><th>D50</th><td>${f(r.D50 * 100, 0, ' %')}</td></tr>`;
}

function teardownViewers() {
  if (state.yawLoop) cancelAnimationFrame(state.yawLoop);
  state.yawLoop = null;
  state.auraliser?.stop();
  state.pano?.destroy(); state.pano = null;
}
