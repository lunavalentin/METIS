// "Version statique": a self-contained ZIP of one project, built in the admin's browser.
// It holds the read-only site (same code, backend "static"), the project data (data/metis.json), the map/360° libraries
// (vendor/) and, optionally, every file of the project downloaded from its Cloudinary (media/), with links rewritten.
// Unzip and serve the folder with any web server (e.g. python3 -m http.server); only the map tiles still come from the internet.

// Site files a static copy needs (main.js and its static imports, translations, logo, shared samples, default charter).
export const SITE_FILES = [
  'index.html', 'scripts/main.js', 'scripts/backend.js', 'scripts/map.js', 'scripts/project.js', 'scripts/i18n.js', 'scripts/upload.js',
  'scripts/media.js', 'scripts/acoustics.js', 'scripts/audio.js', 'scripts/irAnalysis.js', 'scripts/irprocess.js',
  'i18n/fr.json', 'i18n/en.json', 'assets/metis-logo.svg', 'charter/fr.md', 'charter/en.md',
  'assets/samples/clap.wav', 'assets/samples/pluck.wav', 'assets/samples/sweep.wav',
];
const VENDOR = {
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css': 'vendor/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js': 'vendor/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/layers.png': 'vendor/images/layers.png',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/layers-2x.png': 'vendor/images/layers-2x.png',
  'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css': 'vendor/pannellum.css',
  'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js': 'vendor/pannellum.js',
};

// Google Fonts → vendor/fonts.css + the font files it points to (so the archive looks the same offline).
async function bundleFonts(html, zip) {
  const m = html.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)">/);
  if (!m) return html;
  try {
    let css = await (await fetch(m[1].replace(/&amp;/g, '&'))).text();
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(x => x[1]))];
    for (const [i, u] of urls.entries()) {
      const name = `fonts/f${i}.${(u.match(/\.(\w+)$/) || [, 'woff2'])[1]}`;
      zip.file(`vendor/${name}`, await fetchBytes(u), { compression: 'STORE' });
      css = css.split(u).join(name);
    }
    zip.file('vendor/fonts.css', css);
    return html.replace(m[0], '<link rel="stylesheet" href="vendor/fonts.css">').replace(/<link rel="preconnect"[^>]*>\s*/g, '');
  } catch (e) { console.warn('fonts not bundled', e); return html; }
}

let JSZip = null;
async function loadJSZip() {
  if (JSZip) return JSZip;
  await new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js' });
    s.onload = res; s.onerror = () => rej(new Error('JSZip failed to load')); document.head.append(s);
  });
  return (JSZip = window.JSZip);
}

async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function buildStaticZip(state, { includeMedia = true, say = () => {}, t = k => k } = {}) {
  const Zip = await loadJSZip(), zip = new Zip();
  say(t('exp_data'));
  const data = await state.backend.exportProject();
  const pid = data.projectId;

  // 1. site code + vendor libraries (index.html points to the local copies)
  say(t('exp_site'));
  for (const f of SITE_FILES) {
    if (f === 'index.html') {
      let html = await (await fetch('index.html', { cache: 'no-cache' })).text();
      for (const [url, local] of Object.entries(VENDOR)) html = html.split(url).join(local);
      html = await bundleFonts(html, zip);
      zip.file(f, html);
    } else zip.file(f, await fetchBytes(f));
  }
  for (const [url, local] of Object.entries(VENDOR)) zip.file(local, await fetchBytes(url));
  const s = state.site;
  zip.file('config.json', JSON.stringify({ backend: 'static', site: s.site, accounts: s.accounts, defaults: s.defaults }, null, 2));

  // 2. project files: download each Cloudinary file once and point the data at the local copy
  if (includeMedia) {
    const local = new Map(); let n = 0;
    const jobs = [];
    const take = (obj, key, folder) => { const url = obj?.[key]; if (url && /^https:\/\/res\.cloudinary\.com\//.test(url)) jobs.push({ obj, key, folder, url }); };
    for (const its of Object.values(data.items)) for (const it of its) {
      if (it.media) { take(it.media, 'url', it.type); if (it.media.thumbUrl) it.media.thumbUrl = null; }
    }
    for (const l of data.project.layers || []) take(l, 'url', 'plan');
    for (const smp of data.project.samples || []) take(smp, 'url', 'sample');
    for (const job of jobs) {
      if (!local.has(job.url)) {
        say(t('exp_media').replace('{n}', ++n).replace('{total}', new Set(jobs.map(x => x.url)).size));
        const name = `media/${job.folder}/${job.url.split('/').pop().split('?')[0]}`;
        zip.file(name, await fetchBytes(job.url), { compression: 'STORE' });
        local.set(job.url, name);
      }
      job.obj[job.key] = local.get(job.url);
    }
  }
  zip.file('data/metis.json', JSON.stringify(data, null, 1));
  zip.file('LISEZMOI.txt', [
    `METIS — version statique du projet « ${data.project.title?.fr || pid} » (${new Date().toISOString().slice(0, 10)})`, '',
    'Ouvrir : dans ce dossier, lancer un serveur web, par exemple', '  python3 -m http.server 8000', 'puis aller sur http://localhost:8000',
    '(ouvrir index.html directement depuis le disque ne fonctionne pas : les navigateurs bloquent les modules et les données).', '',
    'Contenu : site en lecture seule (scripts/, index.html), données (data/metis.json), fichiers (media/), bibliothèques (vendor/).',
    'Seuls les fonds de carte (OpenStreetMap, satellite) et les vidéos YouTube/Vimeo viennent encore d’internet.', '',
    `METIS — static version of the project “${data.project.title?.en || pid}”. Serve this folder with any web server (see above).`,
  ].join('\n'));
  say(t('exp_zip'));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
