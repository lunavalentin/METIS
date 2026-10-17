// Delete Cloudinary files that no METIS project uses any more (deleted places / files / plans / samples), project by project,
// each on its own Cloudinary account. Run by .github/workflows/cleanup.yml (nightly + on demand), or by hand:
//   METIS_PRIVATE_KEY="$(cat key.pem)" METIS_BOT_PASSWORD=… node tools/cleanup.mjs [--dry-run]   (PROJECT=<id> for one project)
// Cloud keys: projects/<id>/secrets/cloudinary, RSA-OAEP-encrypted by the admin page; only this job holds the private key.
// Safety: only files older than MIN_AGE_MIN (default 60) are deleted; a project whose items list no file while its folder holds
// more than 5 is skipped (FORCE=1 overrides). Reports → projects/<id>/admin/cleanup and the Actions run summary.
import { readFileSync, appendFileSync } from 'node:fs';
import { referencedIds, planDeletions, decryptSecret } from './cleanup-lib.mjs';

const env = process.env;
const DRY = process.argv.includes('--dry-run') || env.DRY_RUN === 'true';
const MIN_AGE_MS = Number(env.MIN_AGE_MIN ?? 60) * 60e3;
const TRIGGER = env.TRIGGER || 'manual', ONLY = (env.PROJECT || '').trim();
for (const k of ['METIS_PRIVATE_KEY', 'METIS_BOT_PASSWORD']) if (!env[k]) throw new Error(`missing env ${k}`);
const site = JSON.parse(readFileSync('config.json', 'utf8'));
const { apiKey, projectId } = site.firebase;
const FS = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const REF = { Referer: 'https://lunavalentin.github.io/' }; // the Firebase API key is restricted to this website
const j = async (r, what) => { if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return r.json(); };

// --- Firebase (bot account, custom claim role "service") ---
const user = env.METIS_BOT_USER || 'nettoyage';
const auth = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...REF },
  body: JSON.stringify({ email: user.includes('@') ? user : `${user}@${site.accounts.emailDomain}`, password: env.METIS_BOT_PASSWORD, returnSecureToken: true }),
}), 'Firebase login');
const H = { Authorization: `Bearer ${auth.idToken}`, ...REF };
// Firestore REST value → plain JS
const plain = v => v == null ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : 'nullValue' in v ? null
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(plain) : 'mapValue' in v ? fields(v.mapValue.fields) : null;
const fields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, plain(v)]));
async function list(path) {
  const out = []; let page = '';
  do {
    const d = await j(await fetch(`${FS}/${path}?pageSize=300${page ? `&pageToken=${page}` : ''}`, { headers: H }), `list ${path}`);
    out.push(...(d.documents || [])); page = d.nextPageToken || '';
  } while (page);
  return out;
}
async function getDoc(path) { const r = await fetch(`${FS}/${path}`, { headers: H }); return r.status === 404 ? null : fields((await j(r, `get ${path}`)).fields); }
const val = x => (typeof x === 'number' ? { integerValue: String(x) } : typeof x === 'boolean' ? { booleanValue: x } : Array.isArray(x) ? { arrayValue: { values: x.map(val) } } : { stringValue: String(x) });

async function cleanProject(pid, projectDoc) {
  const report = { trigger: TRIGGER, dryRun: DRY, places: 0, referenced: 0, stored: 0, orphans: 0, tooRecent: 0, deleted: 0, freedBytes: 0, errors: [] };
  try {
    const secret = await getDoc(`projects/${pid}/secrets/cloudinary`);
    if (!secret?.enc) { report.errors.push('no Cloudinary API keys for this project (Réglages → Stockage)'); return report; }
    const { apiKey: key, apiSecret } = await decryptSecret(env.METIS_PRIVATE_KEY, secret.enc);
    const settings = await getDoc(`projects/${pid}/private/settings`);
    const cloud = settings?.cloudinary?.cloudName || projectDoc.cloudinary?.cloudName;
    const folder = (projectDoc.cloudinary?.folder || `metis/${pid}`).replace(/\/$/, '');
    if (!cloud) { report.errors.push('no Cloudinary cloud name'); return report; }
    // files still used
    const items = [];
    const points = await list(`projects/${pid}/points`);
    report.places = points.length;
    for (const p of points) for (const it of await list(`projects/${pid}/points/${p.name.split('/').pop()}/items`)) items.push(fields(it.fields));
    const referenced = referencedIds(projectDoc, items);
    report.referenced = referenced.size;
    // files stored
    const CH = { Authorization: 'Basic ' + btoa(`${key}:${apiSecret}`) }, CA = `https://api.cloudinary.com/v1_1/${cloud}`;
    const ck = await fetch(`${CA}/usage`, { headers: CH });
    if (ck.status === 401) {
      const shape = v => `${v.length} chars, ${/^\d+$/.test(v) ? 'digits only' : 'not only digits'}`;
      throw new Error(`Cloudinary rejected the keys for cloud "${cloud}": ${(await ck.text()).slice(0, 100)} — API key: ${shape(key)}; secret: ${shape(apiSecret)}`);
    }
    const assets = [];
    for (const type of ['image', 'video', 'raw']) {
      let cursor = '';
      do {
        const d = await j(await fetch(`${CA}/resources/${type}/upload?prefix=${encodeURIComponent(folder + '/')}&max_results=500${cursor ? `&next_cursor=${cursor}` : ''}`, { headers: CH }), `list ${type}`);
        assets.push(...d.resources.map(r => ({ type, id: r.public_id, bytes: r.bytes, created: Date.parse(r.created_at) })));
        cursor = d.next_cursor || '';
      } while (cursor);
    }
    report.stored = assets.length;
    const { orphans, old, tooRecent } = planDeletions(assets, referenced, Date.now(), MIN_AGE_MS);
    report.orphans = orphans.length; report.tooRecent = tooRecent;
    const usedByItems = items.filter(it => it.media).length;
    if (usedByItems === 0 && !(projectDoc.layers?.length || projectDoc.samples?.length) && assets.length > 5 && env.FORCE !== '1') {
      report.errors.push(`safety stop: the project uses no file but its folder holds ${assets.length}; nothing deleted (FORCE=1 to override)`);
    } else if (DRY) {
      report.wouldDelete = old.map(a => `${a.type}:${a.id}`);
    } else {
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
  } catch (e) { report.errors.push(e.message); }
  return report;
}

const projects = (await list('projects')).map(d => ({ id: d.name.split('/').pop(), doc: fields(d.fields) })).filter(p => !ONLY || p.id === ONLY);
if (ONLY && !projects.length) throw new Error(`project ${ONLY} not found`);
let failed = 0;
for (const { id, doc } of projects) {
  const report = await cleanProject(id, doc);
  const { wouldDelete, ...stored } = report;
  const fieldsOut = Object.fromEntries(Object.entries(stored).map(([k, x]) => [k, val(x)]));
  fieldsOut.lastRun = { timestampValue: new Date().toISOString() };
  await j(await fetch(`${FS}/projects/${id}/admin/cleanup`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: fieldsOut }) }), `write report ${id}`);
  const line = `${id}: ${report.places} places, ${report.referenced} files in use, ${report.stored} stored, ${report.orphans} orphaned (${report.tooRecent} too recent), `
    + `${report.deleted} deleted, ${(report.freedBytes / 1048576).toFixed(1)} MB freed${report.errors.length ? ` — ${report.errors.join(' | ')}` : ''}`;
  console.log(line);
  if (wouldDelete) console.log('  would delete:', wouldDelete.join(', ') || '(none)');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  if (report.errors.some(e => !e.startsWith('no Cloudinary API keys'))) failed++;
}
console.log(`METIS cleanup (${DRY ? 'dry run' : 'live'}, ${TRIGGER}): ${projects.length} project(s)`);
if (failed) process.exitCode = 1;
