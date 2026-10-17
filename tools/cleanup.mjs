// Delete Cloudinary files that no METIS item references any more (deleted on the site), so they stop being stored.
// Run by .github/workflows/cleanup.yml in an instance repo (nightly + on demand), or by hand:
//   CLOUDINARY_API_KEY=… CLOUDINARY_API_SECRET=… METIS_BOT_USER=nettoyage METIS_BOT_PASSWORD=… node tools/cleanup.mjs [--dry-run]
// Reads config.json (Firebase web config, project id, Cloudinary folder) and the cloud name from projects/<id>/private/settings.
// Safety: only files older than MIN_AGE_MIN (default 60) are deleted (an upload may be in progress); if Firestore lists no
// referenced file while Cloudinary holds more than 5, nothing is deleted unless FORCE=1. Writes a report to projects/<id>/admin/cleanup.
import { readFileSync, appendFileSync } from 'node:fs';

const env = process.env;
const DRY = process.argv.includes('--dry-run') || env.DRY_RUN === 'true';
const MIN_AGE_MS = Number(env.MIN_AGE_MIN ?? 60) * 60e3;
const TRIGGER = env.TRIGGER || 'manual';
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const { apiKey, projectId } = cfg.firebase;
const pid = cfg.project.id, folder = cfg.cloudinary.folder.replace(/\/$/, '');
for (const k of ['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'METIS_BOT_USER', 'METIS_BOT_PASSWORD']) if (!env[k]) throw new Error(`missing env ${k}`);

const FS = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const REF = { Referer: 'https://lunavalentin.github.io/' }; // the Firebase API key is restricted to these websites
const j = async (r, what) => { if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return r.json(); };

// --- Firebase (bot account, role "service") ---
const email = env.METIS_BOT_USER.includes('@') ? env.METIS_BOT_USER : `${env.METIS_BOT_USER}@${cfg.accounts.emailDomain}`;
const auth = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...REF }, body: JSON.stringify({ email, password: env.METIS_BOT_PASSWORD, returnSecureToken: true }),
}), 'Firebase login');
const H = { Authorization: `Bearer ${auth.idToken}`, ...REF };
async function listDocs(path) {
  const out = []; let page = '';
  do {
    const d = await j(await fetch(`${FS}/${path}?pageSize=300${page ? `&pageToken=${page}` : ''}`, { headers: H }), `list ${path}`);
    out.push(...(d.documents || [])); page = d.nextPageToken || '';
  } while (page);
  return out;
}
const str = (doc, ...keys) => keys.reduce((v, k) => v?.mapValue?.fields?.[k] ?? v?.[k], { mapValue: { fields: doc.fields } })?.stringValue;

const settings = await j(await fetch(`${FS}/projects/${pid}/private/settings`, { headers: H }), 'read settings');
const cloud = str(settings, 'cloudinary', 'cloudName');
if (!cloud) throw new Error('no Cloudinary cloud name in projects/<id>/private/settings');

// Every file still used by an item (hidden items included: they are still on the site for staff).
const referenced = new Set();
const points = await listDocs(`projects/${pid}/points`);
for (const p of points) {
  for (const it of await listDocs(`projects/${pid}/points/${p.name.split('/').pop()}/items`)) {
    const id = str(it, 'media', 'publicId');
    const url = str(it, 'media', 'url');
    if (id) referenced.add(id);
    else if (url?.includes('/upload/')) referenced.add(url.split('/upload/')[1].replace(/^v\d+\//, '').replace(/\.[a-z0-9]+$/i, ''));
  }
}

// --- Cloudinary Admin API ---
const CH = { Authorization: 'Basic ' + btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`) };
const CA = `https://api.cloudinary.com/v1_1/${cloud}`;
const assets = [];
for (const type of ['image', 'video', 'raw']) {
  let cursor = '';
  do {
    const d = await j(await fetch(`${CA}/resources/${type}/upload?prefix=${encodeURIComponent(folder + '/')}&max_results=500${cursor ? `&next_cursor=${cursor}` : ''}`, { headers: CH }), `list ${type}`);
    assets.push(...d.resources.map(r => ({ type, id: r.public_id, bytes: r.bytes, created: Date.parse(r.created_at) })));
    cursor = d.next_cursor || '';
  } while (cursor);
}
// raw public ids keep their extension; image/video ids do not — compare both forms.
const isUsed = a => referenced.has(a.id) || referenced.has(a.id.replace(/\.[a-z0-9]+$/i, ''));
const orphans = assets.filter(a => !isUsed(a));
const old = orphans.filter(a => Date.now() - a.created > MIN_AGE_MS);
const report = { trigger: TRIGGER, dryRun: DRY, places: points.length, referenced: referenced.size, stored: assets.length,
  orphans: orphans.length, tooRecent: orphans.length - old.length, deleted: 0, freedBytes: 0, errors: [] };

if (referenced.size === 0 && assets.length > 5 && env.FORCE !== '1') {
  report.errors.push(`safety stop: Firestore lists no referenced file but Cloudinary holds ${assets.length}; nothing deleted (set FORCE=1 to override)`);
} else if (!DRY) {
  for (const type of ['image', 'video', 'raw']) {
    const ids = old.filter(a => a.type === type);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const q = new URLSearchParams([...batch.map(a => ['public_ids[]', a.id]), ['invalidate', 'true']]);
      const r = await fetch(`${CA}/resources/${type}/upload?${q}`, { method: 'DELETE', headers: CH });
      const d = r.ok ? await r.json() : null;
      if (!d) { report.errors.push(`delete ${type}: HTTP ${r.status}`); continue; }
      for (const a of batch) if (d.deleted?.[a.id] === 'deleted') { report.deleted++; report.freedBytes += a.bytes || 0; }
    }
  }
}

// Report → Firestore (shown in ⚙ Réglages) and the Actions run summary.
const v = x => (typeof x === 'number' ? { integerValue: String(x) } : typeof x === 'boolean' ? { booleanValue: x } : Array.isArray(x) ? { arrayValue: { values: x.map(v) } } : { stringValue: String(x) });
const fields = Object.fromEntries(Object.entries(report).map(([k, x]) => [k, v(x)]));
fields.lastRun = { timestampValue: new Date().toISOString() };
await j(await fetch(`${FS}/projects/${pid}/admin/cleanup`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }), 'write report');

const line = `METIS cleanup (${DRY ? 'dry run' : 'live'}, ${TRIGGER}): ${report.places} places, ${report.referenced} files in use, ${report.stored} stored, `
  + `${report.orphans} orphaned (${report.tooRecent} too recent), ${report.deleted} deleted, ${(report.freedBytes / 1048576).toFixed(1)} MB freed`
  + (report.errors.length ? `\nERRORS: ${report.errors.join(' | ')}` : '');
console.log(line);
if (DRY) console.log('would delete:', old.map(a => `${a.type}:${a.id}`).join('\n  ') || '(none)');
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line.replace(/\n/g, '\n\n') + '\n');
if (report.errors.length) process.exitCode = 1;
