// Freeze a project to a static site: Firestore → data/metis.json, Cloudinary files → assets/frozen/.
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node tools/freeze.mjs <projectId>
// Then set "backend": "static" in config.json and commit. Hidden items are dropped.
// DRAFT — not yet run against real data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const pid = process.argv[2];
if (!pid) throw new Error('usage: freeze.mjs <projectId>');
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const plain = v => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v);
const clean = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && !v.toDate ? clean(v) : plain(v)]));

async function download(url, dir, id) {
  mkdirSync(dir, { recursive: true });
  const ext = (url.match(/\.(\w+)(?:\?|$)/) || [, 'bin'])[1];
  const path = `${dir}/${id}.${ext}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

const project = (await db.doc(`projects/${pid}`).get()).data() || {};
const points = [], items = {};
let n = 0;
for (const p of (await db.collection(`projects/${pid}/points`).get()).docs) {
  if (p.data().hidden) continue;
  points.push({ id: p.id, ...clean(p.data()) });
  items[p.id] = [];
  for (const it of (await p.ref.collection('items').orderBy('createdAt', 'desc').get()).docs) {
    const d = clean(it.data());
    if (d.hidden) continue;
    if (d.media?.url) {
      d.media.url = await download(d.media.url, `assets/frozen/${d.type}`, it.id);
      d.media.thumbUrl = d.type === 'photo' || d.type === 'pano' ? d.media.url : null; // TODO: generate local thumbs
      n++;
    }
    items[p.id].push({ id: it.id, ...d });
  }
}
mkdirSync('data', { recursive: true });
writeFileSync('data/metis.json', JSON.stringify({ project: clean(project), points, items }, null, 1));
console.log(`froze ${points.length} points, ${n} files → data/metis.json, assets/frozen/`);
