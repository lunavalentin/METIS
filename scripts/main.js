// METIS — UI glue: boot, login/logout + charter, places (add / edit / move / delete), place panel with tabs
// (Info · Gallery · Sounds · Texts · Acoustics), item form (add / edit, CAVERN links), full-screen 360° / CAVERN viewer
// (CAVERN = 360° photo + convolution with the linked IR, as in the CAVERN template).
import { initI18n, t, tr, getLang, setLang, applyI18n } from './i18n.js';
import { createBackend } from './backend.js';
import { MetisMap, TYPE_COLORS } from './map.js';
import { uploadMedia, videoEmbed, thumbnail } from './upload.js';
import { checkFile, fixAndCheck, adminOverride, DEFAULT_LIMITS, GROUP, fmtMB } from './media.js';
import { mountPlayer, mountAnalysis, stopAll, isPlaying, setOrientation, linkedPano, linkedIR } from './acoustics.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStaff = u => u && (u.role === 'instructor' || u.role === 'admin');
const isAdmin = u => u?.role === 'admin';
const canEditPoint = (u, p) => !!u && (isAdmin(u) || p.createdBy === u.uid);
const canEditItem = (u, it) => !!u && (isAdmin(u) || it.author?.uid === u.uid);
const canDeleteItem = (u, it) => !!u && (isStaff(u) || it.author?.uid === u.uid);
const toDate = v => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const fmtDate = v => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleString(getLang(), { dateStyle: 'medium', timeStyle: 'short' }) : ''; };

// Tabs: which item types each one lists. Acoustics is a tool over the IRs, not a list.
const TABS = { info: [], gallery: ['photo', 'video', 'pano'], sounds: ['audio', 'ir'], texts: ['text'], acoustics: ['ir'] };
const TAB_KEYS = { info: 'tabInfo', gallery: 'tabGallery', sounds: 'tabSounds', texts: 'tabTexts', acoustics: 'tabAcoustics' };
// Accepted uploads (see media.js for size/duration limits). Videos are links only (no file storage).
const SOUND_ACCEPT = '.mp3,.wav,.aif,.aiff,audio/mpeg,audio/wav,audio/x-wav,audio/aiff,audio/x-aiff';
const ACCEPT = { photo: '.jpg,.jpeg,.png,image/jpeg,image/png', pano: '.jpg,.jpeg,.png,image/jpeg,image/png', audio: SOUND_ACCEPT, ir: SOUND_ACCEPT };
// Limits: defaults ← config.limits ← per-place overrides (point.limits, admins only).
const limitsFor = p => {
  const c = state.config.limits || {};
  return { ...DEFAULT_LIMITS, ...c, perPlace: { ...DEFAULT_LIMITS.perPlace, ...c.perPlace, ...(p?.limits || {}) } };
};
const groupCount = g => state.items.filter(it => GROUP[it.type] === g).length;
const fmtDur = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const ITEM_TYPES = ['photo', 'pano', 'video', 'audio', 'ir', 'text'];
const IR_FORMATS = ['mono', 'stereo', 'binaural', 'foa-ambix', 'foa-fuma'];
const IR_METHODS = ['clap', 'balloon', 'sweep', 'other'];
const META_TEXT = ['description', 'users', 'intendedUse', 'unintendedUses', 'poetic', 'conditions'];
const PLACE_META = [...META_TEXT];
// Questions about the place itself; not asked again for each image (they live in the place's Infos tab).
const PLACE_QUESTIONS = ['users', 'intendedUse', 'unintendedUses'];

const state = {
  config: null, backend: null, map: null, user: null, adding: false, moving: null,
  points: [], point: null, items: [], unwatchItems: null, unwatchPoints: null, tab: 'info', acousticsIR: null,
  viewerPano: null, viewerLoop: null,
};

boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="fatal">${esc(e.message)}</p>`); });

async function boot() {
  state.config = await (await fetch('config.json')).json();
  await initI18n(state.config.project.defaultLang);
  state.backend = await createBackend(state.config);
  renderHeader();

  state.map = new MetisMap($('#map'), state.config, {
    onPointClick: openPoint,
    onMapClick: coords => (state.moving ? movePointTo(coords) : state.adding && createPointAt(coords)),
  });
  const alignId = new URLSearchParams(location.search).get('align');
  if (alignId) state.map.startAlign(alignId);

  state.backend.onUser(async user => {
    state.user = user;
    state.config.uploadSettings = user ? (await state.backend.getSettings().catch(() => ({}))).cloudinary || {} : {};
    renderHeader();
    if (state.point) renderPanel();
    if (user && !user.charterAcceptedAt) await showCharter();
    startWatching();
  });
}

async function startWatching() {
  const project = await state.backend.getProject();
  if (project === null) { $('#notice').textContent = t('classOnly'); $('#notice').hidden = false; return; }
  $('#notice').hidden = true;
  state.unwatchPoints?.();
  state.unwatchPoints = state.backend.watchPoints(pts => {
    state.points = pts;
    state.map.setPoints(pts);
    if (state.point) {
      const fresh = pts.find(p => p.id === state.point.id);
      if (!fresh) return closePoint();               // deleted (here or by someone else)
      state.point = fresh;
      if (!(state.tab === 'acoustics' && isPlaying())) renderPanel();
    }
  }, err => console.warn(err));
}

// ---------- header ----------
function renderHeader() {
  const c = state.config, u = state.user;
  $('#title').textContent = tr(c.project.title);
  $('#subtitle').textContent = tr(c.project.subtitle);
  const current = state.map?.floor ?? c.floors[0]?.id;
  $('#floors').hidden = c.floors.length < 2;
  $('#floors').setAttribute('aria-label', t('floor'));
  $('#floors').innerHTML = c.floors.map(f => `<button data-floor="${esc(f.id)}" class="${f.id === current ? 'on' : ''}">${esc(tr(f.label))}</button>`).join('');
  $('#floors').querySelectorAll('[data-floor]').forEach(b => (b.onclick = () => { state.map.setFloor(b.dataset.floor, { focus: true }); renderHeader(); }));
  $('#lang').textContent = getLang() === 'fr' ? 'EN' : 'FR';
  $('#lang').title = t('switchLang');
  $('#lang').onclick = () => {
    setLang(getLang() === 'fr' ? 'en' : 'fr');
    applyI18n(); renderHeader(); state.map.relabel();
    if (state.point) renderPanel();
  };
  $('#add').hidden = !u || state.backend.readOnly;
  $('#add').onclick = () => toggleAdding(!state.adding);
  $('#auth').hidden = state.backend.readOnly;
  $('#auth').classList.toggle('avatar', !!u);
  $('#auth').innerHTML = u ? `<span class="initials">${esc(u.displayName.slice(0, 2).toUpperCase())}</span>` : esc(t('login'));
  $('#auth').title = u ? `${u.displayName} · ${t('logout')}` : '';
  $('#auth').onclick = () => (u ? confirmLogout() : showLogin());
  $('#settings').hidden = !isAdmin(u) || state.backend.readOnly;
  $('#settings').title = t('settings'); $('#settings').setAttribute('aria-label', t('settings'));
  $('#settings').onclick = showSettings;
  applyI18n();
}

function toggleAdding(on) {
  state.adding = on;
  if (on) state.moving = null;
  state.map.setCursorMode(on);
  $('#add').classList.toggle('active', on);
  document.body.classList.toggle('adding', on);
  $('#hint').hidden = !on;
  $('#hint').textContent = t('addPointHint');
}

// ---------- dialogs ----------
function dialog(html, onSubmit, { el = '#dialog' } = {}) {
  const d = $(el);
  d.innerHTML = `<form method="dialog">${html}</form>`;
  const form = d.querySelector('form');
  form.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => d.close()));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('menu button:last-child'); if (btn) btn.disabled = true;
    try { if ((await onSubmit(new FormData(form), form)) !== false) d.close(); }
    catch (err) { console.error(err); form.querySelector('.err').textContent = ({ UPLOAD_NOT_CONFIGURED: t('uploadNotConfigured'), IMAGE_DECODE: t('imageDecode'), NETWORK: t('networkError') })[err.message] || err.message; }
    finally { if (btn) btn.disabled = false; }
  });
  d.showModal();
  return form;
}

// Styled yes/no on its own <dialog>, so it can sit on top of an open form.
function confirmDialog(message, okLabel, { danger = false } = {}) {
  return new Promise(resolve => {
    const d = $('#confirm');
    d.innerHTML = `<form method="dialog"><p class="confirm-msg">${esc(message)}</p>
      <menu><button value="no" type="submit">${t('cancel')}</button><button value="yes" type="submit" class="${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button></menu></form>`;
    d.onclose = () => resolve(d.returnValue === 'yes');
    d.returnValue = 'no';
    d.showModal();
    d.querySelector('[value=no]').focus();
  });
}

// Admin settings: file storage (Cloudinary, kept in Firestore so it is not public) and class-only / public switch.
async function showSettings() {
  const [settings, project] = await Promise.all([state.backend.getSettings(), state.backend.getProject()]);
  const c = settings.cloudinary || {};
  dialog(`
    <h2>${t('settings')}</h2>
    <h3 class="section-title">${t('storageTitle')}</h3>
    <p class="hint small">${t('storageHint')}</p>
    <label>${t('cloudName')}<input name="cloudName" value="${esc(c.cloudName || '')}" autocapitalize="none" spellcheck="false" placeholder="ex. dxyz12345"></label>
    <label>${t('uploadPreset')}<input name="uploadPreset" value="${esc(c.uploadPreset || '')}" autocapitalize="none" spellcheck="false" placeholder="ex. metis_esaaa"></label>
    <h3 class="section-title">${t('visibilityTitle')}</h3>
    <label class="check"><input type="checkbox" name="public" ${project?.public ? 'checked' : ''}> ${t('projectPublic')}</label>
    <p class="hint small">${t('projectPublicHint')}</p>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async fd => {
      const cloudinary = { cloudName: String(fd.get('cloudName')).trim(), uploadPreset: String(fd.get('uploadPreset')).trim() };
      await state.backend.saveSettings({ cloudinary });
      const pub = fd.get('public') === 'on';
      if (!!project?.public !== pub) {
        if (pub && !(await confirmDialog(t('confirmPublic'), t('projectPublic')))) return false;
        await state.backend.setPublic(pub);
      }
      state.config.uploadSettings = cloudinary;
    });
}

async function confirmLogout() {
  if (await confirmDialog(t('confirmLogout'), t('logout'))) {
    closePoint();
    await state.backend.logout();
  }
}

function showLogin() {
  dialog(`
    <h2>${t('login')}</h2>
    <label>${t('username')}<input name="u" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <label>${t('password')}<input name="p" type="password" autocomplete="current-password" required></label>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('login')}</button></menu>`,
    async fd => {
      try { await state.backend.login(fd.get('u'), fd.get('p')); }
      catch (e) {
        console.warn('login failed', e.code, e.message);
        // Wrong username/password → friendly message; anything else (network, API key, config) → show the code.
        const cred = ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'];
        throw new Error(cred.includes(e.code) ? t('loginError') : `${t('loginError')} (${e.code || e.message})`);
      }
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

// ---------- places ----------
const metaField = (k, value = '', area = true, max = 1000) =>
  `<label>${t('f_' + k)}${area ? `<textarea name="${k}" rows="2" maxlength="${max}">${esc(value)}</textarea>` : `<input name="${k}" maxlength="200" value="${esc(value)}">`}</label>`;
const readTags = fd => String(fd.get('tags') || '').split(',').map(s => s.trim()).filter(Boolean);

function createPointAt(coords) {
  toggleAdding(false);
  const geo = state.map.mode === 'geo';
  const form = dialog(`
    <h2>${t('addPoint')}</h2>
    <label>${t('pointName')}<input name="name" required maxlength="80"></label>
    ${metaField('description')}
    ${geo ? `<button type="button" data-gps>${t('useGps')}</button><small class="gps"></small>` : ''}
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async fd => {
      const name = fd.get('name').trim();
      const id = await state.backend.addPoint({ ...coords, name, meta: { description: fd.get('description') || '' } });
      state.tab = 'info';
      openPoint({ id, name, ...coords, createdBy: state.user.uid, createdByName: state.user.displayName });
    });
  form.querySelector('[data-gps]')?.addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      p => { coords.lat = p.coords.latitude; coords.lng = p.coords.longitude; form.querySelector('.gps').textContent = `±${Math.round(p.coords.accuracy)} m`; },
      err => (form.querySelector('.gps').textContent = err.message),
      { enableHighAccuracy: true, timeout: 15000 });
  });
}

function editPlace() {
  const p = state.point, m = p.meta || {};
  const floors = state.config.floors.map(f => `<option value="${esc(f.id)}" ${f.id === p.floor ? 'selected' : ''}>${esc(tr(f.label))}</option>`).join('');
  const form = dialog(`
    <h2>${t('editPlace')}</h2>
    <label>${t('pointName')}<input name="name" required maxlength="80" value="${esc(p.name)}"></label>
    <label>${t('floor')}<select name="floor">${floors}</select></label>
    ${PLACE_META.map(k => metaField(k, m[k])).join('')}
    ${metaField('tags', (m.tags || []).join(', '), false)}
    ${isAdmin(state.user) ? `<h3 class="section-title">${t('lim_placeLimits')}</h3>
    <div class="limits-row">${['images', 'sounds', 'texts'].map(g => `<label>${t('lim_' + g)}<input type="number" min="0" max="50" name="lim_${g}" value="${limitsFor(p).perPlace[g]}"></label>`).join('')}</div>` : ''}
    <div class="row-actions">
      <button type="button" data-move>${t('movePlace')}</button>
      <button type="button" data-delete class="danger">${t('deletePlace')}</button>
    </div>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async fd => {
      const meta = { ...m, tags: readTags(fd) };
      for (const k of PLACE_META) meta[k] = fd.get(k) || '';
      const patch = { name: fd.get('name').trim(), floor: fd.get('floor'), meta };
      if (isAdmin(state.user)) patch.limits = Object.fromEntries(['images', 'sounds', 'texts'].map(g => [g, Math.max(0, Number(fd.get('lim_' + g)) || 0)]));
      await state.backend.updatePoint(p.id, patch);
    });
  form.querySelector('[data-move]').onclick = () => {
    $('#dialog').close();
    state.moving = p.id;
    state.map.setCursorMode(true);
    $('#hint').hidden = false; $('#hint').textContent = t('movePlaceHint');
  };
  form.querySelector('[data-delete]').onclick = () => deletePlace();
}

async function movePointTo(coords) {
  const id = state.moving;
  state.moving = null; state.map.setCursorMode(false); $('#hint').hidden = true;
  // Keep the place on its level; only the position changes.
  const pos = state.map.mode === 'plan' ? { x: coords.x, y: coords.y } : { lat: coords.lat, lng: coords.lng };
  await state.backend.updatePoint(id, pos);
}

async function deletePlace() {
  const n = state.items.length;
  const ok = await confirmDialog(t('confirmDeletePlace').replace('{name}', state.point.name).replace('{n}', n), t('deletePlace'), { danger: true });
  if (!ok) return;
  const id = state.point.id;
  $('#dialog').close();
  closePoint();
  await state.backend.deletePoint(id);
}

function openPoint(point) {
  state.point = point;
  state.acousticsIR = null;
  state.unwatchItems?.();
  state.unwatchItems = state.backend.watchItems(point.id, items => {
    state.items = items;
    // Do not cut a sound that is playing because someone else just uploaded something.
    if (state.tab === 'acoustics' && isPlaying()) return updateTabCounts();
    renderPanel();
  });
  $('#panel').hidden = false;
  document.body.classList.add('panel-open');
  renderPanel();
}

function closePoint() {
  state.unwatchItems?.(); state.unwatchItems = null;
  state.point = null; stopAll();
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
}

// ---------- panel ----------
function visibleItems() {
  return state.items.filter(it => !it.hidden || isStaff(state.user) || it.author?.uid === state.user?.uid);
}
const tabCount = k => (k === 'info' ? 0 : visibleItems().filter(it => TABS[k].includes(it.type)).length);

function tabsHTML() {
  return Object.keys(TABS).map(k => {
    const n = tabCount(k);
    return `<button data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${t(TAB_KEYS[k])}${n ? `<span class="count">${n}</span>` : ''}</button>`;
  }).join('');
}
function updateTabCounts() { const nav = $('#panel .tabs'); if (nav) { nav.innerHTML = tabsHTML(); wireTabs(); } }
function wireTabs() {
  $('#panel').querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => { stopAll(); state.tab = b.dataset.tab; renderPanel(); }));
}

function renderPanel() {
  if (!state.point) return;
  const p = state.point, items = visibleItems();
  const listed = items.filter(it => TABS[state.tab].includes(it.type));
  const canAdd = state.user && !state.backend.readOnly;
  let body;
  if (state.tab === 'info') body = infoTab(items);
  else if (state.tab === 'acoustics') body = `<div class="acoustics"></div>`;
  else body = listed.map(itemCard).join('') || `<p class="empty">${t('noItems')}</p>`;
  $('#panel').innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header>
      <div><p class="kicker">${items.length} ${t('itemsN')} · ${new Set(items.map(it => it.author?.uid)).size} ${t('contributors')}</p><h2>${esc(p.name)}</h2></div>
      <button class="close icon" aria-label="${esc(t('close'))}" title="${esc(t('close'))}"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </header>
    <nav class="tabs">${tabsHTML()}</nav>
    ${canAdd && state.tab !== 'acoustics' ? `<button class="add-item">+ ${t('addItem')}</button>` : ''}
    <section class="tab-body">${body}</section>`;

  $('#panel .close').onclick = closePoint;
  wireTabs();
  const defaultType = { gallery: 'photo', sounds: 'audio', texts: 'text' }[state.tab] || 'photo';
  $('#panel .add-item')?.addEventListener('click', () => showItemForm(defaultType));
  $('#panel [data-edit-place]')?.addEventListener('click', editPlace);
  $('#panel').querySelectorAll('[data-act]').forEach(b => (b.onclick = () => itemAction(b.dataset.act, b.dataset.id)));
  if (state.tab === 'acoustics') renderAcoustics($('#panel .acoustics'), items);
}

function infoTab(items) {
  const p = state.point, m = p.meta || {}, u = state.user;
  const floor = state.config.floors.find(f => f.id === p.floor);
  const rows = PLACE_META.filter(k => m[k]).map(k => `<dt>${t('f_' + k)}</dt><dd>${esc(m[k]).replace(/\n/g, '<br>')}</dd>`).join('');
  const counts = ITEM_TYPES.map(ty => [ty, items.filter(it => it.type === ty).length]).filter(([, n]) => n)
    .map(([ty, n]) => `<span class="type-chip" style="--c:${TYPE_COLORS[ty]}"><i></i>${n} ${esc(t('type_' + ty))}</span>`).join('');
  const people = [...new Map(items.map(it => [it.author?.uid, it.author?.displayName])).values()].filter(Boolean);
  return `
    <div class="info-card">
      <dl class="facts">
        <dt>${t('floor')}</dt><dd>${esc(tr(floor?.label) || '—')}</dd>
        <dt>${t('createdBy')}</dt><dd>${esc(p.createdByName || '—')}${p.createdAt ? ` · ${esc(fmtDate(p.createdAt))}` : ''}</dd>
        ${people.length ? `<dt>${t('contributorsList')}</dt><dd>${people.map(esc).join(', ')}</dd>` : ''}
      </dl>
      ${counts ? `<div class="chips">${counts}</div>` : ''}
    </div>
    <h3 class="section-title">${t('placeMeta')}</h3>
    ${rows || (m.tags || []).length ? `<dl class="meta-list">${rows}</dl>${(m.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}` : `<p class="empty small">${t('placeMetaEmpty')}</p>`}
    ${canEditPoint(u, p) && !state.backend.readOnly ? `<button class="wide" data-edit-place>${t('editPlace')}</button>` : ''}`;
}

function metaBlock(it) {
  const m = it.meta || {}, ir = it.irInfo;
  const rows = [
    ...META_TEXT.filter(k => m[k]).map(k => [t('f_' + k), m[k]]),
    ...(m.device ? [[t('f_device'), m.device]] : []),
    ...(ir ? [[t('f_irFormat'), ir.format], [t('f_irMethod'), t('method_' + ir.method)], ...(ir.source ? [[t('f_irSource'), ir.source]] : []), ...(ir.receiver ? [[t('f_irReceiver'), ir.receiver]] : [])] : []),
    ...(m.credit ? [[t('f_credit'), m.credit]] : []),
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const tags = (m.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('');
  return rows || tags ? `<details><summary>${t('metadata')}</summary><dl>${rows}</dl>${tags}</details>` : '';
}

function actions(it) {
  const u = state.user;
  const btns = [];
  if (it.type === 'pano') {
    btns.push(`<button data-act="expand" data-id="${it.id}">${t('expand')}</button>`);
    if (linkedIR(it, visibleItems())) btns.push(`<button data-act="cavern" data-id="${it.id}" class="grad">${t('openCavern')}</button>`);
  }
  if (it.type === 'ir') btns.push(`<button data-act="listen" data-id="${it.id}" class="grad">${t('listenHere')}</button>`);
  if (u && !state.backend.readOnly) {
    if (canEditItem(u, it)) btns.push(`<button data-act="edit" data-id="${it.id}">${t('edit')}</button>`);
    if (isStaff(u)) btns.push(`<button data-act="${it.hidden ? 'unhide' : 'hide'}" data-id="${it.id}">${t(it.hidden ? 'unhide' : 'hide')}</button>`);
    if (canDeleteItem(u, it)) btns.push(`<button data-act="delete" data-id="${it.id}" class="danger-text">${t('delete')}</button>`);
  }
  return btns.length ? `<div class="actions">${btns.join('')}</div>` : '';
}

function itemCard(it) {
  const m = it.meta || {};
  let media = '';
  if (it.type === 'photo') media = `<a href="${esc(it.media.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(it.media.thumbUrl || it.media.url)}" alt="${esc(m.title)}"></a>`;
  if (it.type === 'pano') media = `<button class="pano-thumb" data-act="expand" data-id="${it.id}" aria-label="${esc(t('expand'))}"><img loading="lazy" src="${esc(it.media.thumbUrl || thumbnail(it.media.url, 'pano', 800) || it.media.url)}" alt="${esc(m.title)}"><span class="badge">360°</span></button>`;
  if (it.type === 'video') media = it.videoLink
    ? (videoEmbed(it.videoLink) ? `<iframe src="${esc(videoEmbed(it.videoLink))}" allowfullscreen loading="lazy"></iframe>` : `<a href="${esc(it.videoLink)}" target="_blank" rel="noopener">${esc(it.videoLink)}</a>`)
    : `<video controls preload="none" poster="${esc(it.media.thumbUrl || '')}" src="${esc(it.media.url)}"></video>`;
  if (it.type === 'audio' || it.type === 'ir') media = `<audio controls preload="none" src="${esc(it.media.url)}"></audio>`;
  if (it.type === 'text') media = `<blockquote>${esc(m.text).replace(/\n/g, '<br>')}</blockquote>`;
  const badge = `<span class="type-chip small" style="--c:${TYPE_COLORS[it.type]}"><i></i>${esc(t('type_' + it.type))}${it.type === 'ir' && it.irInfo?.format ? ` · ${esc(it.irInfo.format)}` : ''}</span>`;
  return `<article class="item ${it.hidden ? 'is-hidden' : ''}" style="--c:${TYPE_COLORS[it.type]}">
    ${media}
    <div class="item-head">${badge}<h3>${esc(m.title || t('untitled'))}</h3></div>
    <p class="byline">${t('by')} ${esc(it.author?.displayName)}${m.capturedAt ? ` · ${esc(fmtDate(m.capturedAt))}` : ''}</p>
    ${metaBlock(it)}${actions(it)}
  </article>`;
}

async function itemAction(act, id) {
  const pid = state.point.id, it = state.items.find(x => x.id === id);
  if (act === 'delete' && await confirmDialog(t('confirmDelete').replace('{title}', it?.meta?.title || t('untitled')), t('delete'), { danger: true })) await state.backend.deleteItem(pid, id);
  if (act === 'hide') await state.backend.setHidden(pid, id, true);
  if (act === 'unhide') await state.backend.setHidden(pid, id, false);
  if (act === 'edit') showItemForm(it.type, it);
  if (act === 'expand') openViewer(it);
  if (act === 'cavern') openViewer(it, linkedIR(it, visibleItems()));
  if (act === 'listen') { state.acousticsIR = id; state.tab = 'acoustics'; renderPanel(); }
}

// ---------- add / edit item ----------
function showItemForm(type, existing = null) {
  const editing = !!existing;
  const m = existing?.meta || {}, ir = existing?.irInfo || {};
  const items = visibleItems();
  const panos = items.filter(x => x.type === 'pano'), irs = items.filter(x => x.type === 'ir');
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const local = v => { const d = toDate(v); return d ? new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : now; };
  const L = limitsFor(state.point);
  const isFull = k => !editing && GROUP[k] && groupCount(GROUP[k]) >= L.perPlace[GROUP[k]];
  if (!editing && ITEM_TYPES.every(isFull)) { confirmDialog(t('lim_allFull'), t('close')); return; }
  if (isFull(type)) type = ITEM_TYPES.find(k => !isFull(k));
  const opts = ITEM_TYPES.map(k => `<option value="${k}" ${k === type ? 'selected' : ''} ${isFull(k) ? 'disabled' : ''}>${t('type_' + k)}${isFull(k) ? ` (${t('lim_full')})` : ''}</option>`).join('');
  let prepared = null; // { file, check } — the file that will be uploaded, after checks / fixes
  const sel = (name, list, cur) => `<select name="${name}">${list.map(([v, label]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const linkOpts = (list, cur) => sel('', [['', t('none')], ...list.map(x => [x.id, x.meta?.title || `${t('type_' + x.type)} · ${x.author?.displayName}`])], cur);
  const form = dialog(`
    <h2>${editing ? t('editItem') : t('addItem')}</h2>
    <label>${t('type')}<select name="type" ${editing ? 'disabled' : ''}>${opts}</select></label>
    <div data-for="file"><label>${t('file')}${editing ? ` <small>(${t('fileKept')})</small>` : ''}<input name="file" type="file"></label>
      <p class="hint small limits-hint"></p><div class="filecheck" hidden></div></div>
    <div data-for="video"><label>${t('videoLink')}<input name="videoLink" type="url" value="${esc(existing?.videoLink || '')}"></label></div>
    <div data-for="text">${metaField('text', m.text, true, L.textMax)}<p class="hint small chars"></p></div>
    <div data-for="ir">
      <label>${t('f_irFormat')}${sel('irFormat', IR_FORMATS.map(f => [f, f]), ir.format)}</label>
      <label>${t('f_irMethod')}${sel('irMethod', IR_METHODS.map(f => [f, t('method_' + f)]), ir.method)}</label>
      <label class="check"><input type="checkbox" name="irRaw" ${ir.raw ? 'checked' : ''}> ${t('rawClap')}</label>
      ${metaField('irSource', ir.source, false)}${metaField('irReceiver', ir.receiver, false)}
      ${panos.length ? `<label>${t('f_linkPano')}${linkOpts(panos, existing?.linkedPano || '').replace('<select name=""', '<select name="linkedPano"')}</label>` : ''}
    </div>
    <div data-for="panoLink">${irs.length ? `<label>${t('f_linkIR')}${linkOpts(irs, existing?.linkedIR || '').replace('<select name=""', '<select name="linkedIR"')}</label>` : ''}</div>
    <div data-for="rot"><label>${t('f_rotation')}<input name="rotationDeg" type="number" step="1" value="${esc(ir.rotationDeg ?? existing?.panoInfo?.northOffsetDeg ?? 0)}"></label></div>
    <div data-for="device">${metaField('device', m.device, false)}</div>
    ${metaField('title', m.title, false)}
    <label>${t('f_capturedAt')}<input name="capturedAt" type="datetime-local" value="${local(m.capturedAt)}"></label>
    ${META_TEXT.map(k => PLACE_QUESTIONS.includes(k) ? `<div data-for="placeQ">${metaField(k, m[k])}</div>` : metaField(k, m[k])).join('')}
    ${metaField('credit', m.credit, false)}
    ${metaField('tags', (m.tags || []).join(', '), false)}
    <progress hidden max="1" value="0"></progress>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async (fd, f) => {
      const ty = editing ? existing.type : fd.get('type');
      const meta = { ...m, tags: readTags(fd), capturedAt: fd.get('capturedAt') ? new Date(fd.get('capturedAt')).toISOString() : null };
      for (const k of ['title', ...META_TEXT, 'credit', 'text', 'device']) meta[k] = fd.get(k) || '';
      const item = { meta };
      const link = String(fd.get('videoLink') || '').trim(), hasFile = !!prepared;
      if (ty === 'text' && (meta.text || '').length > L.textMax) throw new Error(t('chars').replace('{n}', meta.text.length).replace('{max}', L.textMax));
      if (ty === 'video') {
        if (!videoEmbed(link)) throw new Error(t('videoLinkInvalid'));
        item.videoLink = link; if (!editing) item.media = null;
      } else if (ty !== 'text' && (hasFile || !editing)) {
        if (!hasFile) throw new Error(t('file') + ' ?');
        if (!prepared.check.ok) throw new Error(t('lim_fixFirst'));
        const bar = f.querySelector('progress'); bar.hidden = false;
        item.media = await uploadMedia(state.config, ty, prepared.file, p => (bar.value = p));
      }
      if (ty === 'ir') {
        item.irInfo = { format: fd.get('irFormat'), method: fd.get('irMethod'), raw: fd.get('irRaw') === 'on',
          source: fd.get('irSource') || '', receiver: fd.get('irReceiver') || '', rotationDeg: Number(fd.get('rotationDeg')) || 0 };
        item.linkedPano = fd.get('linkedPano') || null;
      }
      if (ty === 'pano') { item.panoInfo = { northOffsetDeg: Number(fd.get('rotationDeg')) || 0 }; item.linkedIR = fd.get('linkedIR') || null; }
      if (editing) await state.backend.updateItem(state.point.id, existing.id, item);
      else await state.backend.addItem(state.point.id, { type: ty, ...item });
    });

  const box = form.querySelector('.filecheck');
  const curType = () => (editing ? existing.type : form.elements.type.value);
  const fill = (key, info = {}) => t(key).replace('{size}', fmtMB(info.size || 0)).replace('{max}', fmtMB(info.max || 0)).replace('{dur}', fmtDur(info.dur || 0));
  const showCheck = () => {
    box.hidden = !prepared;
    if (!prepared) return;
    const { file, check } = prepared;
    if (check.ok) { box.innerHTML = `<p class="ok">✓ ${esc(file.name)} · ${fmtMB(file.size)}${check.info?.dur ? ` · ${fmtDur(check.info.dur)}` : ''}${check.override ? ` · <b>${t('adminOverridden')}</b>` : ''}</p>`; return; }
    const ov = isAdmin(state.user) ? adminOverride(check, file, L) : null;
    box.innerHTML = check.problems.map(k => `<p class="warn">${esc(fill(k, check.info))}</p>`).join('') +
      check.fixes.map((fx, i) => `<button type="button" class="grad" data-fix="${i}">${t(fx.key)}</button>`).join(' ') +
      (ov?.allowed ? ` <button type="button" data-override>${t('fix_adminOverride')}</button>` : '') +
      (ov && !ov.allowed ? `<p class="hint small">${esc(t('lim_adminTooBig').replace('{max}', fmtMB(ov.max)))}</p>` : '');
    box.querySelector('[data-override]')?.addEventListener('click', () => { prepared = { file, check: ov.check }; showCheck(); });
    box.querySelectorAll('[data-fix]').forEach(b => (b.onclick = async () => {
      b.disabled = true; b.textContent = t('fixing');
      try { prepared = await fixAndCheck(curType(), check.fixes[Number(b.dataset.fix)], L); }
      catch (e) { console.warn(e); box.insertAdjacentHTML('beforeend', `<p class="warn">${esc(t('audioError'))} (${esc(e.message)})</p>`); }
      showCheck();
    }));
  };
  form.elements.file.addEventListener('change', async () => {
    const file = form.elements.file.files[0];
    prepared = null; showCheck();
    if (!file) return;
    box.hidden = false; box.innerHTML = `<p class="hint small">${t('checking')}</p>`;
    prepared = { file, check: await checkFile(curType(), file, L) };
    showCheck();
  });
  const chars = form.querySelector('.chars'), textEl = form.elements.text;
  const countChars = () => (chars.textContent = t('chars').replace('{n}', textEl.value.length).replace('{max}', L.textMax));
  textEl.addEventListener('input', countChars); countChars();
  const sync = () => {
    const ty = curType();
    const show = { file: !['text', 'video'].includes(ty), video: ty === 'video', text: ty === 'text', ir: ty === 'ir', panoLink: ty === 'pano', rot: ty === 'ir' || ty === 'pano', device: ty === 'audio' || ty === 'ir', placeQ: !['photo', 'pano'].includes(ty) };
    form.querySelectorAll('[data-for]').forEach(el => (el.hidden = !show[el.dataset.for]));
    if (ACCEPT[ty]) form.elements.file.accept = ACCEPT[ty];
    const g = GROUP[ty];
    form.querySelector('.limits-hint').textContent = ['photo', 'pano'].includes(ty)
      ? t('lim_hintImage').replace('{max}', ty === 'pano' ? L.panoMaxMB : L.photoMaxMB)
      : ['audio', 'ir'].includes(ty) ? t('lim_hintSound').replace('{max}', L.soundMaxMB) : '';
    if (isAdmin(state.user) && ['photo', 'pano', 'audio', 'ir'].includes(ty)) form.querySelector('.limits-hint').textContent += ' ' + t('lim_adminHint').replace('{max}', L.adminMaxMB);
    if (g && !editing) form.querySelector('.limits-hint').textContent += ' ' + t('lim_count').replace('{n}', groupCount(g)).replace('{max}', L.perPlace[g]);
    if (prepared) { prepared = null; form.elements.file.value = ''; showCheck(); }
  };
  form.elements.type.addEventListener('change', sync); sync();
}

// ---------- acoustics tab ----------
function renderAcoustics(el, items) {
  const irs = items.filter(it => it.type === 'ir');
  if (!irs.length) {
    el.innerHTML = `<p class="empty">${t('noIR')}</p>${state.user && !state.backend.readOnly ? `<button class="wide add-ir">+ ${t('type_ir')}</button>` : ''}`;
    el.querySelector('.add-ir')?.addEventListener('click', () => showItemForm('ir'));
    return;
  }
  const cur = irs.find(x => x.id === state.acousticsIR) || irs[0];
  state.acousticsIR = cur.id;
  const pano = linkedPano(cur, items);
  el.innerHTML = `
    <div class="aur">
      <label>${t('chooseIR')}<select class="ir-pick">${irs.map(it => `<option value="${it.id}" ${it.id === cur.id ? 'selected' : ''}>${esc(it.meta?.title || it.author?.displayName)} · ${esc(it.irInfo?.format)}</option>`).join('')}</select></label>
      <p class="ir-meta">${t('by')} ${esc(cur.author?.displayName)}${cur.irInfo?.method ? ` · ${esc(t('method_' + cur.irInfo.method))}` : ''}${cur.irInfo?.receiver ? ` · ${esc(cur.irInfo.receiver)}` : ''}</p>
      ${pano ? `<button class="wide grad open-cavern">${t('openCavern')}</button><p class="hint small">${t('cavernAvailable')}</p>` : ''}
      <div class="player"></div>
    </div>
    <div class="analysis"></div>`;
  el.querySelector('.ir-pick').onchange = e => { stopAll(); state.acousticsIR = e.target.value; renderPanel(); };
  el.querySelector('.open-cavern')?.addEventListener('click', () => { stopAll(); openViewer(pano, cur); });
  mountPlayer(el.querySelector('.player'), cur, { samples: state.config.audio.samples, recordings: items.filter(it => it.type === 'audio'), t, tr, esc });
  mountAnalysis(el.querySelector('.analysis'), cur, t);
}

// ---------- full-screen 360° / CAVERN viewer ----------
function openViewer(pano, ir = null) {
  closeViewer();
  const v = $('#viewer');
  v.innerHTML = `
    <div class="viewer-bar">
      <div><p class="kicker">${ir ? 'CAVERN · ' + esc(t('cavernHint')) : '360°'}</p><h2>${esc(pano.meta?.title || t('untitled'))}</h2></div>
      <button class="icon close" aria-label="${esc(t('close'))}" title="${esc(t('close'))}"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <div id="viewer-pano"></div>
    ${ir ? `<aside class="viewer-player glass"><p class="kicker">${t('type_ir')} · ${esc(ir.meta?.title || ir.author?.displayName)}</p><div class="player"></div></aside>` : ''}`;
  v.hidden = false;
  document.body.classList.add('viewer-open');
  v.querySelector('.close').onclick = closeViewer;
  state.viewerPano = window.pannellum?.viewer('viewer-pano', {
    type: 'equirectangular', panorama: pano.media.url, autoLoad: true, crossOrigin: 'anonymous',
    northOffset: pano.panoInfo?.northOffsetDeg || 0, compass: false, showFullscreenCtrl: true,
  });
  if (ir) {
    mountPlayer(v.querySelector('.player'), ir, { samples: state.config.audio.samples, recordings: visibleItems().filter(it => it.type === 'audio'), t, tr, esc });
    const loop = () => { if (state.viewerPano) setOrientation(state.viewerPano.getYaw(), state.viewerPano.getPitch()); state.viewerLoop = requestAnimationFrame(loop); };
    state.viewerLoop = requestAnimationFrame(loop);
  }
  document.addEventListener('keydown', escCloses);
}
const escCloses = e => { if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer(); };

function closeViewer() {
  if (state.viewerLoop) cancelAnimationFrame(state.viewerLoop);
  state.viewerLoop = null;
  stopAll();
  state.viewerPano?.destroy(); state.viewerPano = null;
  $('#viewer').hidden = true; $('#viewer').innerHTML = '';
  document.body.classList.remove('viewer-open');
  document.removeEventListener('keydown', escCloses);
}
