// METIS — UI glue: boot, login/logout + charter, places (add / edit / move / delete), place panel with tabs
// (Info · Gallery · Sounds · Texts · Acoustics), item form (add / edit, CAVERN links), full-screen 360° / CAVERN viewer
// (CAVERN = 360° photo + convolution with the linked IR, as in the CAVERN template).
import { initI18n, t, tr, getLang, setLang, applyI18n } from './i18n.js';
import { createBackend } from './backend.js';
import { MetisMap, WorldMap, TYPE_COLORS } from './map.js';
import { toProjectConfig } from './project.js';
import { uploadMedia, videoEmbed, thumbnail } from './upload.js';
import { checkFile, fixAndCheck, adminOverride, decodeSound, encodeWav, looksLikePano, DEFAULT_LIMITS, GROUP, fmtMB } from './media.js';
import { processIR, METIS_SWEEP } from './irprocess.js';
import { analyseIR } from './irAnalysis.js';
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
const TABS = { info: [], gallery: ['photo', 'video', 'pano'], sounds: ['audio'], texts: ['text'], acoustics: ['ir'] };
// Add buttons per tab (none on Infos). Impulse responses are added from Acoustique only.
const TAB_ADD = { gallery: ['photo', 'pano', 'video'], sounds: ['audio'], texts: ['text'], acoustics: ['ir'] };
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

const state = {
  site: null, view: null, world: null, projects: [],
  config: null, backend: null, map: null, user: null, adding: false, moving: null,
  points: [], point: null, items: [], unwatchItems: null, unwatchPoints: null, tab: 'info', acousticsIR: null,
  viewerPano: null, viewerLoop: null,
};

boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="fatal">${esc(e.message)}</p>`); });

const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const notice = msg => { $('#notice').textContent = msg || ''; $('#notice').hidden = !msg; };

async function boot() {
  state.site = await (await fetch('config.json', { cache: 'no-cache' })).json();
  await initI18n(state.site.site.defaultLang);
  state.backend = await createBackend(state.site);
  renderHeader();
  state.backend.onUser(async user => {
    state.user = user;
    try { await route(); } catch (e) { console.error(e); notice(e.message); }
  });
}

// Where to go after load / login / logout:
// static copy → its project; visitor → world map; super-admin → last project (or world); member → their own project.
async function route() {
  const u = state.user, b = state.backend;
  closePoint(); closeViewer();
  if (b.readOnly && b.staticProjectId) return openProject(b.staticProjectId);
  if (!u) return showWorld();
  if (u.role === 'admin') {
    state.projects = await b.listAllProjects();     // for the switcher
    const last = store.get('metis.lastProject');
    if (last && await b.getProjectDoc(last)) return openProject(last);
    return showWorld();
  }
  if (!u.project) { await showWorld(); return notice(t('noProject')); }
  return openProject(u.project);
}

function teardownMaps() {
  state.unwatchPoints?.(); state.unwatchPoints = null;
  $('#admin').hidden = true; document.body.classList.remove('admin-open');
  closePoint();
  state.map?.destroy(); state.map = null;
  state.world?.destroy(); state.world = null;
  toggleAdding(false);
}

// Navigation calls can overlap (login while the world loads, quick saves, double clicks): each one takes a ticket and
// gives up after an await if a newer navigation started, so only the latest builds the map.
let navTicket = 0;

async function showWorld() {
  const b = state.backend, admin = isAdmin(state.user), ticket = ++navTicket;
  const projects = admin ? await b.listAllProjects() : await b.listPublicProjects();
  if (ticket !== navTicket) return;
  teardownMaps(); notice('');
  state.view = 'world'; state.config = null; b.useProject(null);
  state.projects = projects;
  state.world = new WorldMap($('#map'), state.projects, { onProjectClick: p => openProject(p.id), isAdmin: admin });
  renderHeader();
  if (!state.projects.length) notice(t(admin ? 'noProjectsAdmin' : 'noPublicProjects'));
}

async function openProject(pid) {
  const b = state.backend, u = state.user, ticket = ++navTicket;
  const doc = await b.getProjectDoc(pid);
  if (ticket !== navTicket) return;
  if (!doc) { if (u && u.role !== 'admin') { teardownMaps(); renderHeader(); return notice(t('projectUnavailable')); } return showWorld(); }
  const member = u && (u.role === 'admin' || u.project === pid);
  b.useProject(pid);
  const uploadSettings = member ? (await b.getSettings()).cloudinary || {} : {};
  if (ticket !== navTicket) return;
  teardownMaps(); notice('');
  state.view = 'project';
  state.config = toProjectConfig(state.site, doc, pid);
  state.config.uploadSettings = uploadSettings;
  state.config.canWrite = !!member && !b.readOnly && (u.role === 'admin' || state.config.project.status === 'active');
  state.map = new MetisMap($('#map'), state.config, {
    onPointClick: openPoint,
    onMapClick: coords => (state.moving ? movePointTo(coords) : state.adding && createPointAt(coords)),
  });
  const alignId = new URLSearchParams(location.search).get('align');
  if (alignId && isAdmin(u)) state.map.startAlign(alignId);
  if (isAdmin(u)) store.set('metis.lastProject', pid);
  renderHeader();
  if (state.config.project.status === 'archived') notice(t('archivedNotice'));
  if (u && u.role !== 'admin' && member && !u.charterAcceptedAt) await showCharter();
  startWatching();
}

function startWatching() {
  state.unwatchPoints?.();
  state.unwatchPoints = state.backend.watchPoints(pts => {
    state.points = pts;
    state.map?.setPoints(pts);
    if (state.point) {
      const fresh = pts.find(p => p.id === state.point.id);
      if (!fresh) return closePoint();               // deleted (here or by someone else)
      state.point = fresh;
      if (!(state.tab === 'acoustics' && isPlaying())) renderPanel();
    }
  }, err => console.warn(err));
}

// Shared with admin.js (project creation, settings, accounts, cleanup, export).
export const ctx = { state, $, esc, t, tr, getLang, dialog: (...a) => dialog(...a), confirmDialog: (...a) => confirmDialog(...a),
  openProject: (...a) => openProject(...a), showWorld: (...a) => showWorld(...a), renderHeader: (...a) => renderHeader(...a),
  notice: (...a) => notice(...a), fmtDate: (...a) => fmtDate(...a), toDate: (...a) => toDate(...a), store };

// ---------- header ----------
function renderHeader() {
  const c = state.config, u = state.user, b = state.backend, world = state.view !== 'project', admin = isAdmin(u);
  $('#title').textContent = tr(world ? state.site.site.title : c.project.title);
  $('#subtitle').textContent = tr(world ? state.site.site.subtitle : c.project.subtitle);
  const floors = world ? [] : c.floors;
  const current = state.map?.floor ?? floors[0]?.id;
  $('#floors').hidden = floors.length < 2;
  $('#floors').setAttribute('aria-label', t('floor'));
  $('#floors').innerHTML = floors.map(f => `<button data-floor="${esc(f.id)}" class="${f.id === current ? 'on' : ''}">${esc(tr(f.label))}</button>`).join('');
  $('#floors').querySelectorAll('[data-floor]').forEach(btn => (btn.onclick = () => { state.map.setFloor(btn.dataset.floor, { focus: true }); renderHeader(); }));
  $('#lang').textContent = getLang() === 'fr' ? 'EN' : 'FR';
  $('#lang').title = t('switchLang');
  $('#lang').onclick = () => {
    setLang(getLang() === 'fr' ? 'en' : 'fr');
    applyI18n(); renderHeader(); state.map?.relabel(); state.world?.setProjects(state.projects);
    if (state.point) renderPanel();
  };
  // Back to the world map: visitors browsing a public project (members must log out; super-admins use the switcher).
  $('#back').hidden = world || !!u || (b.readOnly && !!b.staticProjectId);
  $('#back').title = t('backToWorld'); $('#back').setAttribute('aria-label', t('backToWorld'));
  $('#back').onclick = () => showWorld();
  // Project switcher (super-admins).
  $('#switcher').hidden = !admin;
  if (admin) {
    const opts = [...state.projects].sort((a, b2) => (tr(a.title) || a.id).localeCompare(tr(b2.title) || b2.id));
    $('#switcher').innerHTML = `<option value="__world">🌍 ${esc(t('worldMap'))}</option>`
      + opts.map(p => `<option value="${esc(p.id)}">${esc(tr(p.title) || p.id)}${p.status === 'archived' ? ` (${esc(t('archivedShort'))})` : ''}</option>`).join('')
      + `<option value="__new">＋ ${esc(t('newProject'))}</option>`;
    $('#switcher').value = world ? '__world' : c.project.id;
    $('#switcher').onchange = async e => {
      const v = e.target.value;
      if (v === '__new') { e.target.value = world ? '__world' : c.project.id; (await import('./admin.js')).newProjectForm(ctx); return; }
      if (v === '__world') { store.set('metis.lastProject', null); return showWorld(); }
      openProject(v);
    };
  }
  $('#add').hidden = world || !c?.canWrite;
  $('#add').onclick = () => toggleAdding(!state.adding);
  $('#auth').hidden = b.readOnly;
  $('#auth').classList.toggle('avatar', !!u);
  $('#auth').innerHTML = u ? `<span class="initials">${esc(u.displayName.slice(0, 2).toUpperCase())}</span>` : esc(t('login'));
  $('#auth').title = u ? `${u.displayName} · ${t('logout')}` : '';
  $('#auth').onclick = () => (u ? confirmLogout() : showLogin());
  $('#settings').hidden = world || !admin || b.readOnly;
  $('#settings').title = t('projectSettings'); $('#settings').setAttribute('aria-label', t('projectSettings'));
  $('#settings').onclick = async () => (await import('./admin.js')).projectAdmin(ctx);
  applyI18n();
}

function toggleAdding(on) {
  state.adding = on;
  if (on) state.moving = null;
  state.map?.setCursorMode(on);
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
  const own = state.config.project.charter?.[getLang()] || state.config.project.charter?.fr || state.config.project.charter?.en;
  const path = state.config.project.charterPath.replace('{lang}', getLang());
  const text = own || await fetch(path).then(r => (r.ok ? r.text() : '')).catch(() => '');
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
    <div class="limits-row">${['images', 'sounds', 'irs', 'texts'].map(g => `<label>${t('lim_' + g)}<input type="number" min="0" max="50" name="lim_${g}" value="${limitsFor(p).perPlace[g]}"></label>`).join('')}</div>` : ''}
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
      if (isAdmin(state.user)) patch.limits = Object.fromEntries(['images', 'sounds', 'irs', 'texts'].map(g => [g, Math.max(0, Number(fd.get('lim_' + g)) || 0)]));
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
  if (!$('#admin').hidden) return;                 // project settings open: map clicks do not open places
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
  const canAdd = state.user && state.config.canWrite;
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
    ${canAdd && TAB_ADD[state.tab] ? addButtons(TAB_ADD[state.tab]) : ''}
    <section class="tab-body">${body}</section>`;

  $('#panel .close').onclick = closePoint;
  wireTabs();
  $('#panel').querySelectorAll('[data-add]').forEach(b => (b.onclick = () => showItemForm(b.dataset.add)));
  $('#panel [data-edit-place]')?.addEventListener('click', editPlace);
  $('#panel').querySelectorAll('[data-act]').forEach(b => (b.onclick = () => itemAction(b.dataset.act, b.dataset.id)));
  if (state.tab === 'acoustics') renderAcoustics($('#panel .acoustics'), items);
}

function addButtons(types) {
  const L = limitsFor(state.point);
  return `<div class="add-row">${types.map(ty => {
    const g = GROUP[ty], n = g ? groupCount(g) : 0, max = g ? L.perPlace[g] : null, full = g && n >= max;
    return `<button class="add-item" data-add="${ty}" ${full ? 'disabled' : ''} style="--c:${TYPE_COLORS[ty]}">+ ${t(ty === 'video' ? 'addVideoLink' : 'type_' + ty)}${g ? ` <small>${full ? t('lim_full') : `${n}/${max}`}</small>` : ''}</button>`;
  }).join('')}</div>`;
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
    ${canEditPoint(u, p) && state.config.canWrite ? `<button class="wide" data-edit-place>${t('editPlace')}</button>` : ''}`;
}

function metaBlock(it) {
  const m = it.meta || {}, ir = it.irInfo;
  const rows = [
    ...META_TEXT.filter(k => m[k]).map(k => [t('f_' + k), m[k]]),
    ...(m.device ? [[t('f_device'), m.device]] : []),
    ...(ir ? [[t('f_irFormat'), t('irfmt_' + String(ir.format).replace('-', '_'))], [t('f_irMethod'), t('method_' + ir.method)], ...(ir.source ? [[t('f_irSource'), ir.source]] : []), ...(ir.receiver ? [[t('f_irReceiver'), ir.receiver]] : []),
      ...(ir.processing?.steps?.length ? [[t('proc_title'), ir.processing.steps.map(x => t('procstep_' + x)).join(' · ') + (ir.processing.deconv ? ` (${t('proc_' + ir.processing.deconv)})` : '')]] : [])] : []),
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
  if (u && state.config.canWrite) {
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
// Fields shown for each type, in order ("adv:" = inside "Options avancées"). Place questions live in the Infos tab only.
const FORM_FIELDS = {
  photo: ['imageKind', 'file', 'title', 'capturedAt', 'description', 'poetic', 'credit', 'tags'],
  pano: ['imageKind', 'file', 'title', 'capturedAt', 'description', 'poetic', 'linkIR', 'credit', 'tags', 'adv:rotation'],
  video: ['videoLink', 'title', 'capturedAt', 'description', 'credit', 'tags'],
  audio: ['file', 'title', 'capturedAt', 'description', 'poetic', 'conditions', 'device', 'credit', 'tags'],
  ir: ['file', 'title', 'capturedAt', 'irFormat', 'irMethod', 'irSource', 'irReceiver', 'linkPano', 'description', 'tags', 'adv:process', 'adv:rotation'],
  text: ['title', 'text', 'credit', 'tags'],
};
const META_KEYS = ['title', 'description', 'poetic', 'conditions', 'device', 'credit', 'text'];

function showItemForm(type, existing = null, carry = null) {
  const editing = !!existing, ty = editing ? existing.type : type;
  const m = { ...(existing?.meta || {}), ...(carry?.meta || {}) }, ir = existing?.irInfo || {};
  const items = visibleItems();
  const panos = items.filter(x => x.type === 'pano'), irs = items.filter(x => x.type === 'ir');
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const local = v => { const d = toDate(v); return d ? new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : now; };
  const L = limitsFor(state.point);
  if (!editing && GROUP[ty] && groupCount(GROUP[ty]) >= L.perPlace[GROUP[ty]]) { confirmDialog(t('lim_allFull'), t('close')); return; }
  let prepared = null; // { file, check } — the file that will be uploaded, after checks / fixes
  const sel = (name, list, cur) => `<select name="${name}">${list.map(([v, label]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const linkSel = (name, list, cur) => sel(name, [['', t('none')], ...list.map(x => [x.id, x.meta?.title || `${t('type_' + x.type)} · ${x.author?.displayName}`])], cur || '');
  const rotValue = ty === 'ir' ? ir.rotationDeg : existing?.panoInfo?.northOffsetDeg;
  const FIELD = {
    // Only when editing: correct a photo uploaded as the wrong kind (e.g. a 360° saved as a photo).
    imageKind: () => (editing ? `<label>${t('imageKind')}${sel('imageKind', [['photo', t('type_photo')], ['pano', t('type_pano')]], ty)}</label>` : ''),
    file: () => `<label>${t(editing ? 'replaceFile' : 'file')}${editing ? ` <small>(${t('fileKept')})</small>` : ''}<input name="file" type="file" accept="${ACCEPT[ty] || ''}"></label>
      <p class="hint small limits-hint"></p><div class="filecheck" hidden></div>`,
    videoLink: () => `<label>${t('videoLink')}<input name="videoLink" type="url" required value="${esc(existing?.videoLink || '')}" placeholder="https://youtu.be/…"></label>`,
    title: () => metaField('title', m.title, false),
    capturedAt: () => `<label>${t('f_capturedAt')}<input name="capturedAt" type="datetime-local" value="${local(m.capturedAt)}"></label>`,
    text: () => `${metaField('text', m.text, true, L.textMax).replace('rows="2"', 'rows="6" required')}<p class="hint small chars"></p>`,
    description: () => metaField('description', m.description),
    poetic: () => metaField('poetic', m.poetic),
    conditions: () => metaField('conditions', m.conditions),
    device: () => metaField('device', m.device, false),
    credit: () => metaField('credit', m.credit, false).replace(t('f_credit'), ty === 'text' ? t('f_creditText') : t('f_credit')),
    tags: () => metaField('tags', (m.tags || []).join(', '), false),
    irFormat: () => `<label>${t('f_irFormat')}${sel('irFormat', IR_FORMATS.map(f => [f, t('irfmt_' + f.replace('-', '_'))]), ir.format || 'mono')}</label>`,
    irMethod: () => `<label>${t('f_irMethod')}${sel('irMethod', IR_METHODS.map(f => [f, t('method_' + f)]), ir.method || 'clap')}</label>`,
    irSource: () => metaField('irSource', ir.source, false),
    irReceiver: () => metaField('irReceiver', ir.receiver, false),
    linkPano: () => (panos.length ? `<label>${t('f_linkPano')}${linkSel('linkedPano', panos, existing?.linkedPano)}</label>`
      : `<label>${t('f_linkPano')}<select disabled><option>${t('none')}</option></select></label><p class="hint small">${t('noPanoYet')}</p>`),
    linkIR: () => (irs.length ? `<label>${t('f_linkIR')}${linkSel('linkedIR', irs, existing?.linkedIR)}</label>`
      : `<label>${t('f_linkIR')}<select disabled><option>${t('none')}</option></select></label><p class="hint small">${t('noIRYet')}</p>`),
    process: () => `<div class="ir-process">
      <p class="hint small">${t('proc_intro')}</p>
      <label class="check"><input type="checkbox" name="pNormalize" checked> ${t('proc_normalize')}</label>
      <label class="check"><input type="checkbox" name="pAlign" checked> ${t('proc_align')}</label>
      <label class="check"><input type="checkbox" name="pTrim"> ${t('proc_trim')}</label>
      <label class="trim-margin" hidden>${t('proc_trimDb')} <output>+3 dB</output>
        <input type="range" name="pTrimDb" min="0" max="20" step="1" value="3"></label>
      <p class="hint small trim-margin" hidden>${t('proc_trimDbHint')}</p>
      <label>${t('proc_deconv')}<select name="pDeconv">
        <option value="">${t('proc_none')}</option><option value="metis">${t('proc_metis')}</option>
        <option value="custom">${t('proc_custom')}</option><option value="reference">${t('proc_reference')}</option></select></label>
      <div class="p-custom limits-row" hidden>
        <label>${t('proc_f1')}<input type="number" name="pF1" min="1" value="${METIS_SWEEP.f1}"></label>
        <label>${t('proc_f2')}<input type="number" name="pF2" min="1" value="${METIS_SWEEP.f2}"></label>
        <label>${t('proc_dur')}<input type="number" name="pDur" min="0.1" step="0.1" value="${METIS_SWEEP.duration}"></label></div>
      <label class="p-ref" hidden>${t('proc_refFile')}<input type="file" name="pRef" accept="${SOUND_ACCEPT}"></label>
      <button type="button" class="grad" data-preview>${t('proc_preview')}</button>
      <div class="ir-preview"></div></div>`,
    rotation: () => `<label>${t(ty === 'ir' ? 'f_irRotation' : 'f_panoNorth')}<input name="rotationDeg" type="number" step="1" value="${esc(rotValue ?? 0)}"></label><p class="hint small">${t('rotationHint')}</p>`,
  };
  const fields = FORM_FIELDS[ty];
  const main = fields.filter(f => !f.startsWith('adv:')).map(f => FIELD[f]()).join('');
  const adv = fields.filter(f => f.startsWith('adv:')).map(f => FIELD[f.slice(4)]()).join('');
  const form = dialog(`
    <h2>${editing ? `${t('edit')} · ${t('type_' + ty)}` : t('add_' + ty)}</h2>
    ${main}
    ${adv ? `<details class="advanced"><summary>${t('advanced')}</summary>${adv}</details>` : ''}
    <progress hidden max="1" value="0"></progress>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('save')}</button></menu>`,
    async (fd, f) => {
      const has = k => f.elements[k] !== undefined;
      const meta = { ...m };                          // fields not in this form keep their value
      for (const k of META_KEYS) if (has(k)) meta[k] = fd.get(k) || '';
      if (has('tags')) meta.tags = readTags(fd);
      if (has('capturedAt')) meta.capturedAt = fd.get('capturedAt') ? new Date(fd.get('capturedAt')).toISOString() : null;
      else if (!editing) meta.capturedAt = new Date().toISOString();
      const item = { meta };
      if (ty === 'text' && (meta.text || '').length > L.textMax) throw new Error(t('chars').replace('{n}', meta.text.length).replace('{max}', L.textMax));
      if (ty === 'video') {
        const link = String(fd.get('videoLink') || '').trim();
        if (!videoEmbed(link)) throw new Error(t('videoLinkInvalid'));
        item.videoLink = link; if (!editing) item.media = null;
      } else if (has('file') && (prepared || !editing)) {
        if (!prepared) throw new Error(t('file') + ' ?');
        if (ty === 'ir' && procWanted() && prepared.procKey !== procKey()) await runProcessing();
        if (!prepared.check.ok) throw new Error(t('lim_fixFirst'));
        const bar = f.querySelector('progress'); bar.hidden = false;
        item.media = await uploadMedia(state.config, ty, prepared.file, p => (bar.value = p));
      }
      const rot = has('rotationDeg') ? Number(fd.get('rotationDeg')) || 0 : 0;
      if (ty === 'ir') {
        const method = fd.get('irMethod');
        // A new file was processed here (or uploaded as is): no playback-time clean-up. Editing without a new file keeps the old flag.
        item.irInfo = { format: fd.get('irFormat'), method, raw: prepared ? false : !!ir.raw,
          source: fd.get('irSource') || '', receiver: fd.get('irReceiver') || '', rotationDeg: rot,
          processing: prepared?.procReport || ir.processing || null };
        if (has('linkedPano')) item.linkedPano = fd.get('linkedPano') || null;
      }
      if (ty === 'pano') { item.panoInfo = { northOffsetDeg: rot }; if (has('linkedIR')) item.linkedIR = fd.get('linkedIR') || null; }
      if (has('imageKind') && fd.get('imageKind') !== ty) {
        item.type = fd.get('imageKind');
        if (item.type === 'pano') item.panoInfo = { northOffsetDeg: rot };
        await state.backend.addPointType(state.point.id, item.type);
      }
      if (editing) await state.backend.updateItem(state.point.id, existing.id, item);
      else await state.backend.addItem(state.point.id, { type: ty, ...item });
    });

  // IR processing options: extra inputs for custom / reference deconvolution (default: none, whatever the acquisition method).
  const pDeconv = form.elements.pDeconv;
  if (pDeconv) {
    const syncP = () => { form.querySelector('.p-custom').hidden = pDeconv.value !== 'custom'; form.querySelector('.p-ref').hidden = pDeconv.value !== 'reference'; };
    pDeconv.addEventListener('change', syncP);
    syncP();
  }
  // Character counter for texts.
  const chars = form.querySelector('.chars'), textEl = form.elements.text;
  if (chars && textEl) { const count = () => (chars.textContent = t('chars').replace('{n}', textEl.value.length).replace('{max}', L.textMax)); textEl.addEventListener('input', count); count(); }
  // --- IR processing (deconvolve → align → trim → normalise), applied to the chosen file before upload ---
  const procOpts = () => ({
    normalize: !!form.elements.pNormalize?.checked, align: !!form.elements.pAlign?.checked, trim: !!form.elements.pTrim?.checked,
    trimMarginDb: Number(form.elements.pTrimDb?.value ?? 3),
    deconvKind: pDeconv?.value || '',
    params: pDeconv?.value === 'custom' ? { f1: Number(form.elements.pF1.value), f2: Number(form.elements.pF2.value), duration: Number(form.elements.pDur.value) } : METIS_SWEEP,
    ref: form.elements.pRef?.files?.[0] || null,
  });
  const procWanted = () => { const o = procOpts(); return o.normalize || o.align || o.trim || !!o.deconvKind; };
  const procKey = () => { const o = procOpts(); return JSON.stringify({ ...o, ref: o.ref ? `${o.ref.name}:${o.ref.size}` : null }); };
  async function runProcessing() {
    const src = prepared?.original || prepared?.file;
    if (!src) throw new Error(t('file') + ' ?');
    const o = procOpts(), out = form.querySelector('.ir-preview');
    out.innerHTML = `<p class="hint small">${t('fixing')}</p>`;
    let deconv = null;
    if (o.deconvKind === 'reference') { if (!o.ref) throw new Error(t('proc_refMissing')); deconv = { kind: 'reference', reference: await decodeSound(o.ref) }; }
    else if (o.deconvKind) {
      if (!(o.params.f1 > 0 && o.params.f2 > o.params.f1 && o.params.duration > 0)) throw new Error(t('proc_badParams'));
      deconv = { kind: 'ess', params: o.params };
    }
    const { snd, report } = processIR(await decodeSound(src), { deconv, align: o.align, trim: o.trim, trimMarginDb: o.trimMarginDb, normalize: o.normalize });
    const file = new File([encodeWav(snd, 24)], src.name.replace(/\.[^.]+$/, '') + '_ri.wav', { type: 'audio/wav' });
    prepared = { file, original: src, check: await checkFile('ir', file, L), procKey: procKey(),
      procReport: { steps: report.steps, deconv: o.deconvKind || null, ...(o.deconvKind === 'custom' ? { sweep: o.params } : {}),
        ...(o.deconvKind === 'reference' ? { referenceFile: o.ref.name } : {}), removedMs: report.removedMs != null ? Math.round(report.removedMs * 10) / 10 : null, sourceFile: src.name } };
    const a = analyseIR(snd.channels[0], snd.sampleRate), f = v => (v == null || !isFinite(v) ? '—' : v.toFixed(2) + ' s');
    out.innerHTML = `<p class="ok">✓ ${t('proc_done')}: ${report.lengthS.toFixed(2)} s · ${snd.channels.length} ${t('proc_ch')} · ${snd.sampleRate} Hz`
      + (report.removedMs != null ? ` · ${t('proc_removed').replace('{ms}', report.removedMs.toFixed(1))}` : '')
      + (report.trimMarginDb != null ? ` · ${t('proc_cutAt').replace('{db}', report.trimMarginDb)}` : '') + ` · T30 ${f(a.T30)} · EDT ${f(a.EDT)}</p>`
      + `<audio controls src="${URL.createObjectURL(file)}"></audio>`;
    showCheck();
  }
  // Tail-cut sensitivity: shown when the tail is cut (checkbox, or always after a deconvolution); moving it refreshes the preview.
  const trimBox = form.elements.pTrim, trimDb = form.elements.pTrimDb;
  if (trimBox && trimDb) {
    const syncTrim = () => form.querySelectorAll('.trim-margin').forEach(el => (el.hidden = !(trimBox.checked || pDeconv?.value)));
    trimBox.addEventListener('change', syncTrim); pDeconv?.addEventListener('change', syncTrim); syncTrim();
    let timer = null;
    trimDb.addEventListener('input', () => {
      trimDb.previousElementSibling.textContent = `+${trimDb.value} dB`;
      clearTimeout(timer);
      if (prepared && form.querySelector('.ir-preview')?.innerHTML) timer = setTimeout(() => runProcessing().catch(err => console.warn(err)), 350);
    });
  }
  form.querySelector('[data-preview]')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { await runProcessing(); } catch (err) { console.warn(err); form.querySelector('.ir-preview').innerHTML = `<p class="warn">${esc(err.message)}</p>`; }
    e.target.disabled = false;
  });

  // File checks (type, size, duration) with fixes; admins may override size / duration.
  const fileEl = form.elements.file;
  if (!fileEl) return;
  const box = form.querySelector('.filecheck'), hint = form.querySelector('.limits-hint');
  const g = GROUP[ty];
  hint.textContent = ['photo', 'pano'].includes(ty) ? t('lim_hintImage').replace('{max}', ty === 'pano' ? L.panoMaxMB : L.photoMaxMB) : t('lim_hintSound').replace('{max}', L.soundMaxMB);
  if (isAdmin(state.user)) hint.textContent += ' ' + t('lim_adminHint').replace('{max}', L.adminMaxMB);
  if (g && !editing) hint.textContent += ' ' + t('lim_count').replace('{n}', groupCount(g)).replace('{max}', L.perPlace[g]);
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
      try { prepared = await fixAndCheck(ty, check.fixes[Number(b.dataset.fix)], L); }
      catch (e) { console.warn(e); box.insertAdjacentHTML('beforeend', `<p class="warn">${esc(t('audioError'))} (${esc(e.message)})</p>`); }
      showCheck();
    }));
  };
  // 360° detection: a photo that is 2:1 / tagged equirectangular → offer to save it as a 360°; a "360°" that is not 2:1 → warn.
  async function panoHint(file) {
    const r = await looksLikePano(file);
    form.querySelector('.pano-hint')?.remove();
    const note = Object.assign(document.createElement('div'), { className: 'pano-hint filecheck' });
    if (ty === 'photo' && r.pano) {
      note.innerHTML = `<p class="warn">${t(r.reason === 'xmp' ? 'panoDetectedXmp' : 'panoDetectedRatio').replace('{w}', r.w).replace('{h}', r.h)}</p>`
        + `<button type="button" class="grad" data-to-pano>${t(editing ? 'panoSwitchEdit' : 'panoSwitch')}</button>`;
      box.after(note);
      note.querySelector('[data-to-pano]').onclick = () => {
        if (editing) { form.elements.imageKind.value = 'pano'; note.remove(); return; }
        const meta = {}; for (const k of META_KEYS) if (form.elements[k]) meta[k] = form.elements[k].value;
        if (form.elements.tags) meta.tags = readTags(new FormData(form));
        if (form.elements.capturedAt?.value) meta.capturedAt = new Date(form.elements.capturedAt.value).toISOString();
        $('#dialog').close();
        showItemForm('pano', null, { meta, file });
      };
    } else if (ty === 'pano' && r.w && !r.pano) {
      note.innerHTML = `<p class="warn">${t('panoNotTwoToOne').replace('{w}', r.w).replace('{h}', r.h)}</p>`;
      box.after(note);
    }
  }
  fileEl.addEventListener('change', async () => {
    const file = fileEl.files[0];
    prepared = null; showCheck();
    if (!file) return;
    box.hidden = false; box.innerHTML = `<p class="hint small">${t('checking')}</p>`;
    prepared = { file, check: await checkFile(ty, file, L) };
    if (['photo', 'pano'].includes(ty) && prepared.check.ok !== undefined) panoHint(file);
    // IR: preselect the format from the channel count (4 → AmbiX, 2 → stereo, 1 → mono); FuMa / binaural stay a manual choice.
    const nch = prepared.check.info?.channels, fmt = form.elements.irFormat;
    if (ty === 'ir' && fmt && nch) {
      const guess = nch === 4 ? (fmt.value.startsWith('foa') ? fmt.value : 'foa-ambix') : nch === 2 ? (['stereo', 'binaural'].includes(fmt.value) ? fmt.value : 'stereo') : nch === 1 ? 'mono' : fmt.value;
      const changed = guess !== fmt.value; fmt.value = guess;
      let note = form.querySelector('.fmt-note');
      if (!note) { note = Object.assign(document.createElement('p'), { className: 'hint small fmt-note' }); fmt.closest('label').after(note); }
      note.textContent = t(nch === 4 ? 'fmtDetected4' : nch === 2 ? 'fmtDetected2' : nch === 1 ? 'fmtDetected1' : 'fmtDetectedN').replace('{n}', nch) + (changed ? ' ' + t(nch === 4 ? 'fmtChanged4' : nch === 2 ? 'fmtChanged2' : 'fmtChanged') : '');
    }
    showCheck();
  });
  // Editing an existing photo whose stored size is 2:1 (Cloudinary reports width/height): suggest the switch right away.
  const mw = existing?.media?.width, mh = existing?.media?.height;
  if (editing && ty === 'photo' && mw && mh && Math.abs(mw / mh - 2) < 0.03 && mw >= 2000) {
    const note = Object.assign(document.createElement('div'), { className: 'pano-hint filecheck' });
    note.innerHTML = `<p class="warn">${t('panoDetectedRatio').replace('{w}', mw).replace('{h}', mh)}</p><button type="button" class="grad" data-to-pano>${t('panoSwitchEdit')}</button>`;
    form.elements.imageKind.closest('label').after(note);
    note.querySelector('[data-to-pano]').onclick = () => { form.elements.imageKind.value = 'pano'; note.remove(); };
  }
  if (carry?.file) {
    const dt = new DataTransfer(); dt.items.add(carry.file);
    fileEl.files = dt.files; fileEl.dispatchEvent(new Event('change'));
  }
}

// ---------- acoustics tab ----------
function renderAcoustics(el, items) {
  const irs = items.filter(it => it.type === 'ir');
  if (!irs.length) {
    el.innerHTML = `<p class="empty">${t('noIR')}</p>`;
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
    <div class="analysis"></div>
    <h3 class="section-title">${t('irFiles')}</h3>
    ${irs.map(itemCard).join('')}`;
  el.querySelector('.ir-pick').onchange = e => { stopAll(); state.acousticsIR = e.target.value; renderPanel(); };
  el.querySelector('.open-cavern')?.addEventListener('click', () => { stopAll(); openViewer(pano, cur); });
  mountPlayer(el.querySelector('.player'), cur, { samples: state.config.audio.samples, recordings: items.filter(it => it.type === 'audio'), t, tr, esc });
  mountAnalysis(el.querySelector('.analysis'), cur, t);
  el.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => itemAction(b.dataset.act, b.dataset.id)));
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
