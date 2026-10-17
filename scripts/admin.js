// Super-admin tools (Luna, Celeste), loaded on demand from main.js with the shared context (state, dialogs, navigation):
// · newProjectForm — create a project (form or JSON import), test + encrypt the cloud keys, generate the accounts
// · projectAdmin   — project settings panel: Général · Base (levels, plans, view, samples, charter, limits) · Comptes ·
//                    Stockage (cloud, cleanup) · Archive (status, static download)
import { newProjectDoc, PROJECT_ID_RE } from './project.js';
import { encryptSecret, testCloudinary, makePassword, capitalize, usernameCandidates, toCSV, download, pdfPageCount, pdfPageToImage } from './adminlib.js';
import { uploadMedia } from './upload.js';
import { checkFile } from './media.js';
import { buildStaticZip } from './export.js';

const ACC_COLS = ['username', 'password', 'role', 'displayName', 'project'];

// ---------- new project ----------
export async function newProjectForm(ctx) {
  const { t, esc, state } = ctx;
  const c = state.world?.center?.() || { lat: 46.2, lng: 6.15 };
  const form = ctx.dialog(`
    <h2>${t('newProject')}</h2>
    <label>${t('np_import')}<input type="file" name="json" accept="application/json,.json"></label>
    <p class="hint small">${t('np_importHint')}</p>
    <h3 class="section-title">${t('np_identity')}</h3>
    <label>${t('np_id')}<input name="id" required pattern="[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9]" placeholder="esaaa-2026" autocapitalize="none" spellcheck="false"></label>
    <p class="hint small">${t('np_idHint')}</p>
    <div class="limits-row two"><label>${t('np_titleFr')}<input name="titleFr" required></label><label>${t('np_titleEn')}<input name="titleEn"></label></div>
    <div class="limits-row two"><label>${t('np_subFr')}<input name="subFr"></label><label>${t('np_subEn')}<input name="subEn"></label></div>
    <div class="limits-row two"><label>${t('np_start')}<input type="date" name="start"></label><label>${t('np_end')}<input type="date" name="end"></label></div>
    <label class="check"><input type="checkbox" name="public"> ${t('np_public')}</label>
    <h3 class="section-title">${t('np_location')}</h3>
    <div class="search-row"><input name="q" placeholder="${esc(t('np_searchPh'))}"><button type="button" data-search>${t('np_search')}</button></div>
    <div class="search-results"></div>
    <div class="limits-row three"><label>${t('np_lat')}<input name="lat" type="number" step="any" required value="${c.lat.toFixed(5)}"></label>
      <label>${t('np_lng')}<input name="lng" type="number" step="any" required value="${c.lng.toFixed(5)}"></label>
      <label>${t('np_zoom')}<input name="zoom" type="number" min="3" max="21" value="17"></label></div>
    <h3 class="section-title">${t('np_accounts')}</h3>
    <div class="limits-row two"><label>${t('np_students')}<input name="students" type="number" min="0" max="200" value="0"></label>
      <label>${t('np_instructors')}<input name="instructors" type="number" min="0" max="50" value="0"></label></div>
    <h3 class="section-title">${t('np_cloud')}</h3>
    <p class="hint small">${t('np_cloudHint')}</p>
    <div class="limits-row two"><label>${t('cloudName')}<input name="cloudName" required autocapitalize="none" spellcheck="false"></label>
      <label>${t('uploadPreset')}<input name="uploadPreset" required autocapitalize="none" spellcheck="false"></label></div>
    <div class="limits-row two"><label>${t('np_apiKey')}<input name="apiKey" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
      <label>${t('np_apiSecret')}<input name="apiSecret" type="password" autocomplete="off"></label></div>
    <p class="hint small">${t('np_keysHint')}</p>
    <button type="button" data-test>${t('np_test')}</button><p class="hint small test-out" aria-live="polite"></p>
    <p class="hint small progress-out" aria-live="polite"></p>
    <p class="err"></p>
    <menu><button type="button" data-cancel>${t('cancel')}</button><button>${t('np_create')}</button></menu>`,
    async (fd, f) => {
      const id = String(fd.get('id')).trim().toLowerCase();
      if (!PROJECT_ID_RE.test(id)) throw new Error(t('np_badId'));
      if (await state.backend.projectExists(id)) throw new Error(t('np_idTaken').replace('{id}', id));
      const keys = { cloudName: fd.get('cloudName').trim(), uploadPreset: fd.get('uploadPreset').trim(), apiKey: fd.get('apiKey').trim(), apiSecret: fd.get('apiSecret').trim() };
      const say = m => (f.querySelector('.progress-out').textContent = m);
      say(t('np_testing'));
      const test = await testCloudinary({ ...keys, folder: `metis/${id}` });
      showTest(f, test, t);
      if (!test.preset) throw new Error(t('np_testFailed'));
      if (keys.apiKey && test.keys === false) throw new Error(t('np_keysFailed'));
      const doc = newProjectDoc(state.site, { id, title: { fr: fd.get('titleFr').trim(), en: fd.get('titleEn').trim() || fd.get('titleFr').trim() }, center: [Number(fd.get('lat')), Number(fd.get('lng'))] });
      doc.subtitle = { fr: fd.get('subFr').trim(), en: fd.get('subEn').trim() || fd.get('subFr').trim() };
      doc.dates = { start: fd.get('start') || '', end: fd.get('end') || '' };
      doc.public = fd.get('public') === 'on';
      doc.map.zoom = Number(fd.get('zoom')) || 17;
      doc.cloudinary.cloudName = keys.cloudName;
      doc.accounts = { students: Number(fd.get('students')) || 0, instructors: Number(fd.get('instructors')) || 0 };
      Object.assign(doc, f._imported || {});           // floors / limits / charter / samples from an imported JSON
      say(t('np_saving'));
      await state.backend.createProject(id, doc);
      state.backend.useProject(id);
      await state.backend.saveSettings({ cloudinary: { cloudName: keys.cloudName, uploadPreset: keys.uploadPreset } });
      if (keys.apiKey && keys.apiSecret) await state.backend.saveSecrets(await encryptSecret(state.site.secretsPublicKey, { apiKey: keys.apiKey, apiSecret: keys.apiSecret }));
      if (doc.accounts.students + doc.accounts.instructors > 0) {
        const res = await generateAccounts(ctx, id, doc.accounts.students, doc.accounts.instructors, say);
        downloadAccounts(id, res.all);
        if (res.error) await ctx.confirmDialog(t('acc_partial').replace('{n}', res.created.length).replace('{err}', res.error), t('close'));
      }
      state.projects = await state.backend.listAllProjects();
      await ctx.openProject(id);
      projectAdmin(ctx, 'base');
    });
  // JSON import → fill the form (keys included if present; they are never exported)
  form.elements.json.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { fillFromJSON(form, JSON.parse(await file.text())); } catch (err) { form.querySelector('.err').textContent = `JSON: ${err.message}`; }
  });
  form.querySelector('[data-search]').onclick = () => geoSearch(form, t, esc);
  form.elements.q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); geoSearch(form, t, esc); } });
  form.querySelector('[data-test]').onclick = async () => {
    const g = k => form.elements[k].value.trim(), out = form.querySelector('.test-out');
    if (!g('cloudName') || !g('uploadPreset')) { out.textContent = t('np_testNeeds'); return; }
    out.textContent = t('np_testing');
    showTest(form, await testCloudinary({ cloudName: g('cloudName'), uploadPreset: g('uploadPreset'), apiKey: g('apiKey'), apiSecret: g('apiSecret'), folder: `metis/${g('id') || 'test'}` }), t);
  };
}

function showTest(form, r, t) {
  const out = form.querySelector('.test-out');
  const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  r = { ...r, message: e(r.message) };
  out.innerHTML = [
    r.preset ? `✓ ${t('np_presetOk')}` : `✗ ${t('np_presetBad')} (${r.message})`,
    r.keys === true ? `✓ ${t('np_keysOk')}` : r.keys === false ? `✗ ${t('np_keysBad')} (${r.message})` : r.preset ? `– ${t('np_keysSkipped')}` : '',
  ].filter(Boolean).join('<br>');
  out.className = `hint small test-out ${r.preset && r.keys !== false ? 'ok' : 'warn'}`;
}

function fillFromJSON(form, j) {
  const set = (k, v) => { if (v != null && form.elements[k]) form.elements[k].value = v; };
  set('id', j.id); set('titleFr', j.title?.fr); set('titleEn', j.title?.en); set('subFr', j.subtitle?.fr); set('subEn', j.subtitle?.en);
  set('start', j.dates?.start); set('end', j.dates?.end);
  if (j.public != null) form.elements.public.checked = !!j.public;
  const center = j.map?.center || (j.location ? [j.location.lat, j.location.lng] : null);
  if (center) { set('lat', center[0]); set('lng', center[1]); }
  set('zoom', j.map?.zoom ?? j.location?.zoom);
  set('students', j.accounts?.students); set('instructors', j.accounts?.instructors);
  set('cloudName', j.cloudinary?.cloudName); set('uploadPreset', j.cloudinary?.uploadPreset);
  set('apiKey', j.cloudinary?.apiKey); set('apiSecret', j.cloudinary?.apiSecret);
  form._imported = Object.fromEntries(['floors', 'limits', 'charter', 'samples', 'layers'].filter(k => j[k]).map(k => [k, j[k]]));
}

async function geoSearch(form, t, esc) {
  const q = form.elements.q.value.trim(), box = form.querySelector('.search-results');
  if (!q) return;
  box.textContent = '…';
  try {
    const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`)).json();
    box.innerHTML = r.length ? r.map((x, i) => `<button type="button" data-i="${i}">${esc(x.display_name)}</button>`).join('') : esc(t('np_noResult'));
    box.querySelectorAll('[data-i]').forEach(b => (b.onclick = () => {
      const x = r[Number(b.dataset.i)];
      form.elements.lat.value = Number(x.lat).toFixed(6); form.elements.lng.value = Number(x.lon).toFixed(6); box.innerHTML = '';
    }));
  } catch (e) { box.textContent = e.message; }
}

// ---------- accounts ----------
// Creates nStudents + nInstructors accounts for project pid (from this browser, see backend.createAuthUser), records them in
// projects/{pid}/admin/accounts and returns { created, all, error }. Stops at the first unexpected error (e.g. rate limit).
export async function generateAccounts(ctx, pid, nStudents, nInstructors, say = () => {}) {
  const b = ctx.state.backend, t = ctx.t;
  const list = (await b.getAdmin('accounts')).accounts || [];
  const taken = new Set(list.map(a => a.username));
  const names = usernameCandidates(taken);
  const todo = [...Array(nInstructors).fill('instructor'), ...Array(nStudents).fill('student')];
  const created = []; let error = null;
  for (const role of todo) {
    let ok = false;
    while (!ok) {
      const username = names.next().value;
      if (!username) { error = 'no username left'; break; }
      const password = makePassword(), displayName = capitalize(username.replace(/\d+$/, ''));
      try {
        const uid = await b.createAuthUser(username, password, displayName);
        await b.setUserDoc(uid, { project: pid, role, username, displayName, charterAcceptedAt: null, createdAt: new Date().toISOString() });
        const acc = { username, password, role, displayName, project: pid, uid, createdAt: new Date().toISOString() };
        list.push(acc); created.push(acc); taken.add(username); ok = true;
        say(t('acc_progress').replace('{n}', created.length).replace('{total}', todo.length));
        if (created.length % 5 === 0) await b.saveAdmin('accounts', { accounts: list });
      } catch (e) {
        if (e.code === 'auth/email-already-in-use') continue;           // name used in another project → next one
        error = e.code || e.message; break;
      }
    }
    if (error) break;
  }
  await b.saveAdmin('accounts', { accounts: list });
  return { created, all: list, error };
}

function downloadAccounts(pid, list) {
  download(`metis_${pid}_comptes.csv`, toCSV(list, ACC_COLS));
}

// ---------- project settings panel ----------
const TABS = ['general', 'base', 'accounts', 'storage', 'archive'];

export async function projectAdmin(ctx, tab = 'general') {
  const { state, $, t } = ctx;
  if (!state.config) return;
  const panel = $('#admin');
  panel.hidden = false; document.body.classList.add('admin-open');
  panel.innerHTML = `
    <header><div><p class="kicker">${t('projectSettings')}</p><h2>${ctx.esc(ctx.tr(state.config.project.title))}</h2></div>
      <button class="close icon" aria-label="${ctx.esc(t('close'))}"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>
    <nav class="tabs">${TABS.map(k => `<button data-atab="${k}" class="${k === tab ? 'on' : ''}">${t('adm_' + k)}</button>`).join('')}</nav>
    <section class="admin-body"></section>`;
  panel.querySelector('.close').onclick = () => closeAdmin(ctx);
  panel.querySelectorAll('[data-atab]').forEach(btn => (btn.onclick = () => projectAdmin(ctx, btn.dataset.atab)));
  const body = panel.querySelector('.admin-body');
  body.innerHTML = '<p class="hint small">…</p>';
  try { await ({ general: tabGeneral, base: tabBase, accounts: tabAccounts, storage: tabStorage, archive: tabArchive })[tab](ctx, body); }
  catch (e) { console.error(e); body.innerHTML = `<p class="warn">${ctx.esc(e.message)}</p>`; }
}
export function closeAdmin(ctx) { const p = ctx.$('#admin'); p.hidden = true; p.innerHTML = ''; document.body.classList.remove('admin-open'); }

// Saves a patch of the project document, then reloads the project (map, levels, plans) and reopens the panel.
async function saveProject(ctx, patch, tab) {
  ctx.$('#admin').classList.add('busy');              // no second action while this one reloads the project
  try { await ctx.state.backend.updateProject(patch); } catch (e) { ctx.$('#admin').classList.remove('busy'); throw e; }
  await ctx.openProject(ctx.state.config.project.id);
  // refresh the switcher (may fail harmlessly if the admin logged out meanwhile)
  try { ctx.state.projects = await ctx.state.backend.listAllProjects(); ctx.renderHeader(); } catch (e) { console.warn('project list', e.code); }
  if (!ctx.state.config) return;
  ctx.$('#admin').classList.remove('busy');
  projectAdmin(ctx, tab);
}
const doc = ctx => ctx.state.config.doc;
const L = (ctx, v) => ctx.esc(v ?? '');

// --- Général ---
async function tabGeneral(ctx, body) {
  const { t } = ctx, d = doc(ctx);
  body.innerHTML = `<form class="admin-form">
    <div class="limits-row two"><label>${t('np_titleFr')}<input name="titleFr" required value="${L(ctx, d.title?.fr)}"></label><label>${t('np_titleEn')}<input name="titleEn" value="${L(ctx, d.title?.en)}"></label></div>
    <div class="limits-row two"><label>${t('np_subFr')}<input name="subFr" value="${L(ctx, d.subtitle?.fr)}"></label><label>${t('np_subEn')}<input name="subEn" value="${L(ctx, d.subtitle?.en)}"></label></div>
    <div class="limits-row two"><label>${t('np_start')}<input type="date" name="start" value="${L(ctx, d.dates?.start)}"></label><label>${t('np_end')}<input type="date" name="end" value="${L(ctx, d.dates?.end)}"></label></div>
    <label class="check"><input type="checkbox" name="public" ${d.public ? 'checked' : ''}> ${t('np_public')}</label>
    <p class="hint small">${t('projectPublicHint')}</p>
    <div class="row-actions"><button type="button" data-export>${t('adm_exportJson')}</button><button class="grad">${t('save')}</button></div>
    <p class="err"></p></form>`;
  const f = body.querySelector('form');
  f.onsubmit = async e => {
    e.preventDefault();
    const pub = f.elements.public.checked;
    if (pub && !d.public && !(await ctx.confirmDialog(t('confirmPublic'), t('projectPublic')))) return;
    try {
      await saveProject(ctx, { title: { fr: f.elements.titleFr.value.trim(), en: f.elements.titleEn.value.trim() || f.elements.titleFr.value.trim() },
        subtitle: { fr: f.elements.subFr.value.trim(), en: f.elements.subEn.value.trim() }, dates: { start: f.elements.start.value, end: f.elements.end.value }, public: pub }, 'general');
    } catch (err) { f.querySelector('.err').textContent = err.message; }
  };
  f.querySelector('[data-export]').onclick = async () => {
    const s = await ctx.state.backend.getSettings();
    const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !['createdAt', 'createdBy', 'updatedAt', 'updatedBy'].includes(k)));
    const out = { id: ctx.state.config.project.id, ...rest, cloudinary: { cloudName: rest.cloudinary?.cloudName, uploadPreset: s.cloudinary?.uploadPreset } };
    download(`metis_${out.id}.json`, JSON.stringify(out, null, 2), 'application/json');
  };
}

// --- Base: home view, levels + plans, samples, charter, limits ---
async function tabBase(ctx, body) {
  const { t, tr, esc, state } = ctx, d = doc(ctx);
  const floors = structuredClone(state.config.floors), layers = structuredClone(d.layers || []);
  const samples = structuredClone(d.samples || []), lim = state.config.limits;
  const planOf = id => layers.find(l => l.floor === id);
  body.innerHTML = `
    <h3 class="section-title">${t('base_view')}</h3>
    <p class="hint small">${t('base_viewHint')}</p>
    <p class="hint small cur-view">${t('base_current')}: ${esc(JSON.stringify(d.map?.center))} · zoom ${esc(d.map?.zoom)}</p>
    <button type="button" data-view>${t('base_useView')}</button>

    <h3 class="section-title">${t('base_levels')}</h3>
    <p class="hint small">${t('base_levelsHint')}</p>
    <div class="levels">${floors.map((f, i) => {
      const pl = planOf(f.id);
      return `<div class="level" data-i="${i}">
        <div class="limits-row two"><label>${t('base_levelFr')}<input data-k="fr" value="${L(ctx, f.label?.fr)}"></label><label>${t('base_levelEn')}<input data-k="en" value="${L(ctx, f.label?.en)}"></label></div>
        <div class="level-plan">${pl ? `<img src="${esc(pl.url)}" alt=""><span>${t('base_hasPlan')}</span>
            <label class="check"><input type="checkbox" data-lines ${pl.blend === 'lines' ? 'checked' : ''}> ${t('base_lines')}</label>
            <button type="button" data-place>${t('base_place')}</button><button type="button" data-unplan class="danger-text">${t('base_removePlan')}</button>`
          : `<span class="hint small">${t('base_noPlan')}</span>`}
          <label class="upload-btn">${t(pl ? 'base_replacePlan' : 'base_addPlan')}<input type="file" data-plan accept="image/png,image/jpeg,application/pdf,.pdf" hidden></label></div>
        <div class="row-actions"><button type="button" data-up ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-down ${i === floors.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-del class="danger-text" ${floors.length < 2 ? 'disabled' : ''}>${t('delete')}</button></div>
      </div>`; }).join('')}</div>
    <button type="button" data-addlevel>+ ${t('base_addLevel')}</button>
    <p class="hint small plan-status" aria-live="polite"></p>

    <h3 class="section-title">${t('base_samples')}</h3>
    <p class="hint small">${t('base_samplesHint')}</p>
    <div class="samples">${samples.map((s, i) => `<div class="sample" data-i="${i}"><audio controls preload="none" src="${esc(s.url)}"></audio>
      <div class="limits-row two"><input data-k="fr" value="${L(ctx, s.label?.fr)}" placeholder="FR"><input data-k="en" value="${L(ctx, s.label?.en)}" placeholder="EN"></div>
      <button type="button" data-delsample class="danger-text">${t('delete')}</button></div>`).join('')}</div>
    <label class="upload-btn">+ ${t('base_addSample')}<input type="file" data-sample accept=".mp3,.wav,audio/mpeg,audio/wav" hidden></label>

    <h3 class="section-title">${t('base_charter')}</h3>
    <p class="hint small">${t('base_charterHint')}</p>
    <label>FR<textarea data-charter="fr" rows="5">${esc(d.charter?.fr || '')}</textarea></label>
    <label>EN<textarea data-charter="en" rows="5">${esc(d.charter?.en || '')}</textarea></label>

    <h3 class="section-title">${t('base_limits')}</h3>
    <div class="limits-row">${['images', 'sounds', 'irs', 'texts'].map(g => `<label>${t('lim_' + g)}<input type="number" min="0" max="50" data-lim="${g}" value="${lim.perPlace[g]}"></label>`).join('')}</div>
    <div class="limits-row three"><label>${t('base_photoMB')}<input type="number" min="1" max="20" data-limv="photoMaxMB" value="${lim.photoMaxMB}"></label>
      <label>${t('base_panoMB')}<input type="number" min="1" max="20" data-limv="panoMaxMB" value="${lim.panoMaxMB}"></label>
      <label>${t('base_soundMB')}<input type="number" min="1" max="50" data-limv="soundMaxMB" value="${lim.soundMaxMB}"></label></div>
    <div class="row-actions sticky-save"><button type="button" class="grad" data-save>${t('save')}</button></div>
    <p class="err"></p>`;
  const q = s => body.querySelector(s), qa = s => body.querySelectorAll(s);
  const status = m => (q('.plan-status').textContent = m);
  // collect(): copy the form fields into floors / samples (call BEFORE changing those arrays); build(): the patch to save.
  const collect = () => {
    qa('.level').forEach(el => { const f = floors[Number(el.dataset.i)]; if (!f) return; f.label = { fr: el.querySelector('[data-k=fr]').value.trim() || f.id, en: el.querySelector('[data-k=en]').value.trim() || el.querySelector('[data-k=fr]').value.trim() || f.id }; const pl = planOf(f.id); if (pl) pl.blend = el.querySelector('[data-lines]')?.checked ? 'lines' : ''; });
    qa('.sample').forEach(el => { const s = samples[Number(el.dataset.i)]; if (!s) return; s.label = { fr: el.querySelector('[data-k=fr]').value.trim(), en: el.querySelector('[data-k=en]').value.trim() || el.querySelector('[data-k=fr]').value.trim() }; });
    qa('[data-lim]').forEach(i => (limits.perPlace[i.dataset.lim] = Math.max(0, Number(i.value) || 0)));
    qa('[data-limv]').forEach(i => (limits[i.dataset.limv] = Math.max(1, Number(i.value) || 1)));
    charter.fr = q('[data-charter=fr]').value; charter.en = q('[data-charter=en]').value;
    return build();
  };
  const limits = { ...d.limits, perPlace: { ...(d.limits?.perPlace || {}) } }, charter = { ...(d.charter || {}) };
  const build = () => ({ floors, layers: layers.filter(l => floors.some(f => f.id === l.floor)), samples, limits, charter });
  const save = () => saveProject(ctx, collect(), 'base');
  const saveBuilt = () => saveProject(ctx, build(), 'base');
  q('[data-save]').onclick = async () => { try { await save(); } catch (e) { q('.err').textContent = e.message; } };
  q('[data-view]').onclick = async () => { await saveProject(ctx, { ...collect(), map: { ...d.map, ...state.map.view() } }, 'base'); };
  q('[data-addlevel]').onclick = () => {
    collect();
    let n = floors.length; while (floors.some(f => f.id === `l${n}`)) n++;
    floors.push({ id: `l${n}`, label: { fr: `${t('base_level')} ${n}`, en: `Level ${n}` } });
    saveBuilt();
  };
  qa('.level').forEach(el => {
    const i = Number(el.dataset.i), f = floors[i];
    el.querySelector('[data-up]').onclick = () => { collect(); [floors[i - 1], floors[i]] = [floors[i], floors[i - 1]]; saveBuilt(); };
    el.querySelector('[data-down]').onclick = () => { collect(); [floors[i + 1], floors[i]] = [floors[i], floors[i + 1]]; saveBuilt(); };
    el.querySelector('[data-del]').onclick = async () => {
      if (!(await ctx.confirmDialog(t('base_confirmDelLevel').replace('{name}', tr(f.label)), t('delete'), { danger: true }))) return;
      collect(); floors.splice(i, 1); saveBuilt();
    };
    el.querySelector('[data-unplan]')?.addEventListener('click', () => { collect(); const k = layers.findIndex(l => l.floor === f.id); layers.splice(k, 1); saveBuilt(); });
    el.querySelector('[data-place]')?.addEventListener('click', () => { collect(); placePlan(ctx, f.id, collect); });
    el.querySelector('[data-plan]').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        let img = file;
        if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) {
          const n = await pdfPageCount(file);
          let page = 1;
          if (n > 1) page = Math.min(n, Math.max(1, Number(prompt(t('base_pdfPage').replace('{n}', n), '1')) || 1));
          status(t('base_pdfRendering')); img = await pdfPageToImage(file, page);
        }
        status(t('uploading'));
        const media = await uploadMedia(state.config, 'plan', img, p => status(`${t('uploading')} ${Math.round(p * 100)} %`));
        collect();
        const old = layers.findIndex(l => l.floor === f.id);
        const ratio = media.width && media.height ? media.height / media.width : 0.7;
        const center = state.map.view().center;
        const ly = { id: `plan-${f.id}-${Date.now().toString(36)}`, label: f.label, floor: f.id, url: media.url, publicId: media.publicId, opacity: 0.85, blend: '',
          placement: old >= 0 ? layers[old].placement : { center, widthM: 120, heightM: Math.round(120 * ratio * 100) / 100, rotationDeg: 0 } };
        if (old >= 0) layers.splice(old, 1, ly); else layers.push(ly);
        await ctx.state.backend.updateProject(build());
        await ctx.openProject(state.config.project.id);
        placePlan(ctx, f.id, null);
      } catch (err) { console.error(err); status(`${t('audioError')}: ${err.message}`); }
    });
  });
  qa('.sample').forEach(el => (el.querySelector('[data-delsample]').onclick = () => { collect(); samples.splice(Number(el.dataset.i), 1); saveBuilt(); }));
  q('[data-sample]').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const chk = await checkFile('audio', file, state.config.limits);
      if (!chk.ok) throw new Error(chk.problems.map(k => t(k)).join(' '));
      status(t('uploading'));
      const media = await uploadMedia(state.config, 'sample', file, p => status(`${t('uploading')} ${Math.round(p * 100)} %`));
      collect();
      const name = file.name.replace(/\.[^.]+$/, '');
      samples.push({ label: { fr: name, en: name }, url: media.url, publicId: media.publicId });
      await saveBuilt();
    } catch (err) { status(err.message); }
  });
}

// Places the plan of level floorId on the map (placement editor), then saves it into the project.
function placePlan(ctx, floorId, collect) {
  const { state } = ctx;
  const ly = state.config.layers.find(l => l.floor === floorId);
  if (!ly) return;
  closeAdmin(ctx);
  state.map.editLayer(ly.id, {
    onSave: async (placement, opacity) => {
      const base = collect ? collect() : {};
      const layers = (base.layers || structuredClone(doc(ctx).layers)).map(l => (l.id === ly.id ? { ...l, placement, opacity } : l));
      await saveProject(ctx, { ...base, layers }, 'base');
    },
    onCancel: () => projectAdmin(ctx, 'base'),
  });
}

// --- Comptes ---
async function tabAccounts(ctx, body) {
  const { t, esc, state } = ctx, pid = state.config.project.id, b = state.backend;
  const list = (await b.getAdmin('accounts')).accounts || [];
  const order = { instructor: 0, student: 1 };
  const sorted = [...list].sort((a, c) => order[a.role] - order[c.role] || a.username.localeCompare(c.username));
  body.innerHTML = `
    <p class="hint small">${t('acc_hint')}</p>
    <div class="row-actions"><button type="button" data-csv ${list.length ? '' : 'disabled'}>${t('acc_download')}</button><button type="button" data-showpw>${t('acc_showPw')}</button></div>
    <table class="acc-table"><thead><tr><th>${t('username')}</th><th>${t('password')}</th><th>${t('acc_role')}</th><th></th></tr></thead><tbody>
    ${sorted.map(a => `<tr data-u="${esc(a.username)}"><td>${esc(a.username)}</td><td><code class="pw" data-pw="${esc(a.password)}">••••••</code></td>
      <td>${t('role_' + a.role)}</td><td><button type="button" data-reset title="${esc(t('acc_reset'))}">↻</button><button type="button" data-delacc class="danger-text" title="${esc(t('delete'))}">✕</button></td></tr>`).join('')
      || `<tr><td colspan="4" class="hint small">${t('acc_none')}</td></tr>`}
    </tbody></table>
    <h3 class="section-title">${t('acc_add')}</h3>
    <div class="limits-row two"><label>${t('np_students')}<input type="number" min="0" max="200" value="0" data-n="student"></label>
      <label>${t('np_instructors')}<input type="number" min="0" max="50" value="0" data-n="instructor"></label></div>
    <button type="button" class="grad" data-gen>${t('acc_generate')}</button>
    <p class="hint small acc-status" aria-live="polite"></p>`;
  const q = s => body.querySelector(s), say = m => (q('.acc-status').textContent = m);
  q('[data-csv]').onclick = () => downloadAccounts(pid, sorted);
  q('[data-showpw]').onclick = () => body.querySelectorAll('.pw').forEach(c => (c.textContent = c.textContent.startsWith('•') ? c.dataset.pw : '••••••'));
  q('[data-gen]').onclick = async e => {
    const ns = Number(q('[data-n=student]').value) || 0, ni = Number(q('[data-n=instructor]').value) || 0;
    if (!ns && !ni) return;
    e.target.disabled = true;
    try {
      const res = await generateAccounts(ctx, pid, ns, ni, say);
      if (res.created.length) download(`metis_${pid}_nouveaux_comptes.csv`, toCSV(res.created, ACC_COLS));
      if (res.error) await ctx.confirmDialog(t('acc_partial').replace('{n}', res.created.length).replace('{err}', res.error), t('close'));
      projectAdmin(ctx, 'accounts');
    } catch (err) { say(err.message); e.target.disabled = false; }
  };
  body.querySelectorAll('tr[data-u]').forEach(tr => {
    const acc = list.find(a => a.username === tr.dataset.u);
    tr.querySelector('[data-reset]').onclick = async () => {
      if (!(await ctx.confirmDialog(t('acc_confirmReset').replace('{u}', acc.username), t('acc_reset')))) return;
      try {
        const pw = makePassword();
        await b.withUserSession(acc.username, acc.password, (user, A) => A.updatePassword(user, pw));
        acc.password = pw; await b.saveAdmin('accounts', { accounts: list });
        projectAdmin(ctx, 'accounts');
      } catch (err) { say(`${acc.username}: ${err.code || err.message}`); }
    };
    tr.querySelector('[data-delacc]').onclick = async () => {
      if (!(await ctx.confirmDialog(t('acc_confirmDelete').replace('{u}', acc.username), t('delete'), { danger: true }))) return;
      try {
        await b.withUserSession(acc.username, acc.password, user => user.delete());
      } catch (err) { if (err.code !== 'auth/invalid-credential' && err.code !== 'auth/user-not-found') { say(`${acc.username}: ${err.code || err.message}`); return; } }
      await b.deleteUserDoc(acc.uid).catch(() => {});
      await b.saveAdmin('accounts', { accounts: list.filter(a => a !== acc) });
      projectAdmin(ctx, 'accounts');
    };
  });
}

// --- Stockage: cloud settings, key replacement, cleanup ---
async function tabStorage(ctx, body) {
  const { t, esc, state } = ctx, b = state.backend, pid = state.config.project.id;
  const [settings, report, global] = await Promise.all([b.getSettings(), b.getAdmin('cleanup'), b.getGlobal('settings')]);
  const c = settings.cloudinary || {};
  body.innerHTML = `<form class="admin-form">
    <div class="limits-row two"><label>${t('cloudName')}<input name="cloudName" required value="${esc(c.cloudName || '')}" autocapitalize="none" spellcheck="false"></label>
      <label>${t('uploadPreset')}<input name="uploadPreset" required value="${esc(c.uploadPreset || '')}" autocapitalize="none" spellcheck="false"></label></div>
    <div class="limits-row two"><label>${t('np_apiKey')}<input name="apiKey" autocomplete="off" placeholder="${esc(t('adm_keysKeep'))}"></label>
      <label>${t('np_apiSecret')}<input name="apiSecret" type="password" autocomplete="off" placeholder="${esc(t('adm_keysKeep'))}"></label></div>
    <p class="hint small">${t('np_keysHint')}</p>
    <div class="row-actions"><button type="button" data-test>${t('np_test')}</button><button class="grad">${t('save')}</button></div>
    <p class="hint small test-out"></p><p class="err"></p></form>
    <h3 class="section-title">${t('cleanupTitle')}</h3>
    <p class="hint small">${t('cleanupHint')}</p>
    <p class="cleanup-report">${cleanupLine(ctx, report)}</p>
    <label>${t('githubToken')}<input name="githubToken" type="password" autocomplete="off" placeholder="${global.githubToken ? esc(t('tokenSaved')) : 'github_pat_…'}"></label>
    <p class="hint small">${t('githubTokenHint').replace('{repo}', esc(state.site.site.repo))}</p>
    <div class="row-actions"><button type="button" class="grad" data-clean="live">${t('cleanNow')}</button><button type="button" data-clean="dry">${t('cleanDry')}</button></div>
    <p class="hint small clean-status" aria-live="polite"></p>`;
  const f = body.querySelector('form');
  const vals = () => ({ cloudName: f.elements.cloudName.value.trim(), uploadPreset: f.elements.uploadPreset.value.trim(), apiKey: f.elements.apiKey.value.trim(), apiSecret: f.elements.apiSecret.value.trim(), folder: state.config.cloudinary.folder });
  f.querySelector('[data-test]').onclick = async () => { f.querySelector('.test-out').textContent = t('np_testing'); showTest(f, await testCloudinary(vals()), t); };
  f.onsubmit = async e => {
    e.preventDefault();
    const v = vals();
    try {
      await b.saveSettings({ cloudinary: { cloudName: v.cloudName, uploadPreset: v.uploadPreset } });
      if (v.apiKey && v.apiSecret) await b.saveSecrets(await encryptSecret(state.site.secretsPublicKey, { apiKey: v.apiKey, apiSecret: v.apiSecret }));
      await saveProject(ctx, { cloudinary: { ...(doc(ctx).cloudinary || {}), cloudName: v.cloudName } }, 'storage');
    } catch (err) { f.querySelector('.err').textContent = err.message; }
  };
  body.querySelectorAll('[data-clean]').forEach(btn => (btn.onclick = () => runCleanup(ctx, body, pid, btn.dataset.clean === 'dry', global)));
}

function cleanupLine(ctx, r) {
  const { t } = ctx;
  if (!r?.lastRun) return t('cleanupNever');
  const mb = ((Number(r.freedBytes) || 0) / 1048576).toFixed(1);
  return t('cleanupLast').replace('{date}', ctx.fmtDate(r.lastRun)).replace('{deleted}', r.deleted ?? 0).replace('{mb}', mb)
    .replace('{stored}', r.stored ?? 0).replace('{used}', r.referenced ?? 0) + (r.dryRun ? ` (${t('cleanDry').toLowerCase()})` : '')
    + (r.errors?.length ? ` — ⚠ ${ctx.esc(r.errors.join(' · '))}` : '');
}

// Starts .github/workflows/cleanup.yml (site repo) for this project through the GitHub API, then waits for the bot's report.
async function runCleanup(ctx, body, pid, dry, global) {
  const { t, state } = ctx, b = state.backend;
  const status = body.querySelector('.clean-status'), say = m => (status.textContent = m);
  const typed = body.querySelector('[name=githubToken]').value.trim(), token = typed || global.githubToken;
  if (!token) return say(t('githubTokenMissing'));
  if (!dry && !(await ctx.confirmDialog(t('confirmClean'), t('cleanNow')))) return;
  body.querySelectorAll('[data-clean]').forEach(x => (x.disabled = true));
  const started = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${state.site.site.repo}/actions/workflows/cleanup.yml/dispatches`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: 'main', inputs: { project: pid, dry_run: dry, trigger: `${dry ? 'dry-run' : 'admin'}: ${state.user.displayName}` } }),
    });
    if (r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
    if (typed) await b.saveGlobal('settings', { githubToken: typed });
    say(t('cleanStarted'));
    for (let i = 0; i < 60; i++) {
      await new Promise(res => setTimeout(res, 5000));
      const rep = await b.getAdmin('cleanup');
      const when = ctx.toDate(rep.lastRun);
      if (when && when.getTime() > started - 5000) { body.querySelector('.cleanup-report').innerHTML = cleanupLine(ctx, rep); say(t('cleanDone')); return; }
      say(`${t('cleanStarted')} ${Math.round((Date.now() - started) / 1000)} s`);
    }
    say(t('cleanSlow'));
  } catch (e) { console.warn(e); say(`${t('cleanFailed')} (${e.message})`); }
  finally { body.querySelectorAll('[data-clean]').forEach(x => (x.disabled = false)); }
}

// --- Archive & static version ---
async function tabArchive(ctx, body) {
  const { t, state } = ctx, archived = state.config.project.status === 'archived';
  body.innerHTML = `
    <h3 class="section-title">${t('arc_status')}</h3>
    <p>${t(archived ? 'arc_isArchived' : 'arc_isActive')}</p>
    <p class="hint small">${t('arc_hint')}</p>
    <button type="button" class="${archived ? 'grad' : 'danger'}" data-toggle>${t(archived ? 'arc_reopen' : 'arc_archive')}</button>
    <h3 class="section-title">${t('arc_static')}</h3>
    <p class="hint small">${t('arc_staticHint')}</p>
    <label class="check"><input type="checkbox" data-media checked> ${t('arc_withMedia')}</label>
    <button type="button" class="grad" data-zip>${t('arc_download')}</button>
    <p class="hint small zip-status" aria-live="polite"></p>`;
  body.querySelector('[data-toggle]').onclick = async () => {
    if (!(await ctx.confirmDialog(t(archived ? 'arc_confirmReopen' : 'arc_confirmArchive'), t(archived ? 'arc_reopen' : 'arc_archive'), { danger: !archived }))) return;
    await saveProject(ctx, { status: archived ? 'active' : 'archived' }, 'archive');
  };
  body.querySelector('[data-zip]').onclick = async e => {
    const say = m => (body.querySelector('.zip-status').textContent = m);
    e.target.disabled = true;
    try {
      const blob = await buildStaticZip(state, { includeMedia: body.querySelector('[data-media]').checked, say, t });
      download(`metis_${state.config.project.id}_statique.zip`, blob, 'application/zip');
      say(t('arc_done').replace('{mb}', (blob.size / 1048576).toFixed(1)));
    } catch (err) { console.error(err); say(`${t('audioError')}: ${err.message}`); }
    e.target.disabled = false;
  };
}
