// Helpers for the super-admin tools: secret encryption, Cloudinary connection test, account names/passwords, CSV, PDF pages.
// No DOM state here (except PDF rendering to a canvas), so the pieces can be tested on their own.

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

// Encrypt a small object (Cloudinary API key + secret) with the site's public key (RSA-OAEP, SHA-256).
// Only the cleanup job holds the private key (GitHub secret METIS_PRIVATE_KEY); browsers can never decrypt it.
export async function encryptSecret(publicKeyB64, obj) {
  const key = await crypto.subtle.importKey('spki', b64(publicKeyB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return toB64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(JSON.stringify(obj))));
}

async function sha1Hex(s) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
// 1×1 transparent PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Real round trip: unsigned upload with the preset (proves cloud name + preset), then a signed delete of that file
// with the API key/secret (proves the keys, and leaves nothing behind). Returns { preset, keys, publicId, message }.
export async function testCloudinary({ cloudName, uploadPreset, apiKey, apiSecret, folder }) {
  const out = { preset: false, keys: null, message: '' };
  const fd = new FormData();
  fd.append('file', new Blob([b64(TINY_PNG)], { type: 'image/png' }), 'metis-test.png');
  fd.append('upload_preset', uploadPreset);
  fd.append('folder', `${folder}/_test`);
  let r, j;
  try { r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: 'POST', body: fd }); j = await r.json(); }
  catch (e) { out.message = `network: ${e.message}`; return out; }
  if (!r.ok) { out.message = j?.error?.message || `HTTP ${r.status}`; return out; }
  out.preset = true; out.publicId = j.public_id;
  if (!apiKey || !apiSecret) return out;
  const ts = Math.floor(Date.now() / 1000);
  const sig = await sha1Hex(`invalidate=true&public_id=${j.public_id}&timestamp=${ts}${apiSecret}`);
  const del = new FormData();
  del.append('public_id', j.public_id); del.append('timestamp', ts); del.append('invalidate', 'true');
  del.append('api_key', apiKey); del.append('signature', sig);
  try {
    const r2 = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, { method: 'POST', body: del });
    const j2 = await r2.json();
    out.keys = j2.result === 'ok';
    if (!out.keys) out.message = j2?.error?.message || JSON.stringify(j2);
  } catch (e) { out.keys = false; out.message = `network: ${e.message}`; }
  return out;
}

// ---------- accounts ----------
// One-word poetic usernames (ASCII, no accents). When the pool is used up, a number is added.
export const NAME_POOL = `brume echo lichen ressac murmure nacre givre lueur sillage cendre rosee ecume silex opale aurore zephyr galet roseau
ambre fougere saule heron comete prisme rivage alpage nuage orage luciole onde mirage basalte argile bruyere cascade
clairiere corail cristal delta dune embrun estuaire falaise fjord geyser glacier granit grotte houle iris jade jasmin
lagune lavande lierre loriot lotus mangrove marais menhir meteore mousse myrtille neroli oasis obsidienne olivier
orchidee ouragan pampa papyrus passiflore perle pivoine plancton pollen quartz rafale resine roche safran sequoia
sirocco soleil source steppe tamaris thym tilleul tonnerre topaze toundra tourbe trefle tulipe vague verveine
volcan zenith acacia agate alize amande anemone arbouse aubepine azur baobab bleuet bourrasque cedre chene
cigale citrine colibri cyprès dahlia ebene eclipse edelweiss erable etoile faucon figuier flocon gardenia
genet glycine grenat hibiscus hirondelle horizon jonquille lilas lune magnolia marbre mesange mimosa narcisse
nenuphar noisette ocre ondee orme oursin pervenche peuplier pinson platane primevere rubis sable sapin silene
sorbier tempete tourmaline vanille vermeil violette`.replace(/è/g, 'e').split(/\s+/).filter(Boolean);

const PW_WORDS = ['ciel', 'vent', 'lac', 'pin', 'sel', 'mer', 'sol', 'feu', 'bois', 'roc', 'miel', 'lune', 'pluie', 'neige', 'sable',
  'fleur', 'herbe', 'pierre', 'nuit', 'jour', 'aube', 'soir', 'mont', 'pont', 'port', 'voile', 'rame', 'barque', 'plume', 'encre',
  'craie', 'toile', 'corde', 'cloche', 'flute', 'harpe', 'piano', 'tambour', 'violon', 'gong'];
const rnd = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
export const makePassword = () => `${PW_WORDS[rnd(PW_WORDS.length)]}${String(rnd(10000)).padStart(4, '0')}${PW_WORDS[rnd(PW_WORDS.length)]}`;
export const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// Usernames to try, in random order, skipping those already used in this project; numbered variants after the pool.
export function* usernameCandidates(taken = new Set()) {
  const pool = [...NAME_POOL]; for (let i = pool.length - 1; i > 0; i--) { const j = rnd(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const n of pool) if (!taken.has(n)) yield n;
  for (let k = 2; k < 100; k++) for (const n of pool) if (!taken.has(n + k)) yield n + k;
}

export function toCSV(rows, cols) {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n') + '\n';
}
export function download(name, content, type = 'text/csv') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- PDF plans (pdf.js, loaded on demand) ----------
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  await new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' });
    s.onload = res; s.onerror = () => rej(new Error('pdf.js failed to load')); document.head.append(s);
  });
  pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return pdfjs;
}
export async function pdfPageCount(file) { const lib = await loadPdfJs(); return (await lib.getDocument({ data: await file.arrayBuffer() }).promise).numPages; }
// Renders one page (1-based) as a PNG File whose longest side is maxPx (JPEG if the PNG would exceed maxBytes).
export async function pdfPageToImage(file, page = 1, maxPx = 4000, maxBytes = 9e6) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const p = await doc.getPage(page);
  const v1 = p.getViewport({ scale: 1 }), scale = maxPx / Math.max(v1.width, v1.height), vp = p.getViewport({ scale });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(vp.width), height: Math.round(vp.height) });
  const g = canvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: g, viewport: vp }).promise;
  const base = file.name.replace(/\.pdf$/i, '') + `_p${page}`;
  let blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (blob.size <= maxBytes) return new File([blob], base + '.png', { type: 'image/png' });
  blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  return new File([blob], base + '.jpg', { type: 'image/jpeg' });
}
