// Acoustics: CAVERN-style listening through an uploaded IR — a provided dry sample, a recording made at the place,
// the visitor's own file (decoded locally, never uploaded) or their live voice. Shared by the Acoustics tab and the
// CAVIAR view (360° photo + linked IR, head rotation follows the viewer).
import { Auraliser, loadBuffer, audioContext } from './audio.js';
import { analyseIR, cleanImpulse } from './irAnalysis.js';

let auraliser = null;
const irCache = new Map();
const player = () => (auraliser ??= new Auraliser());

export const stopAll = () => auraliser?.stop();
export const isPlaying = () => !!auraliser?.source;
export const setOrientation = (yaw, pitch) => auraliser?.setOrientation(yaw, pitch);

// IR item → AudioBuffer (raw clap/balloon recordings are cleaned first). Cached per item id.
export async function loadIR(item) {
  if (irCache.has(item.id)) return irCache.get(item.id);
  let buf = await loadBuffer(item.media.url);
  if (item.irInfo?.raw) {
    const chans = cleanImpulse([...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c)), buf.sampleRate);
    buf = audioContext().createBuffer(chans.length, chans[0].length, buf.sampleRate);
    chans.forEach((c, i) => buf.copyToChannel(c, i));
  }
  irCache.set(item.id, buf);
  return buf;
}

// IR ↔ 360° links can be set from either side (irItem.linkedPano or panoItem.linkedIR).
export function linkedPano(ir, items) {
  return items.find(p => p.type === 'pano' && (p.id === ir.linkedPano || p.linkedIR === ir.id)) || null;
}
export function linkedIR(pano, items) {
  return items.find(r => r.type === 'ir' && (r.id === pano.linkedIR || r.linkedPano === pano.id)) || null;
}

// Renders source / loop / volume / play / stop into `el` for the given IR item. Returns nothing; uses the shared player.
export function mountPlayer(el, ir, { samples, recordings, t, tr, esc }) {
  el.innerHTML = `
    <label>${t('chooseSource')}
      <select class="src-pick">
        <optgroup label="${esc(t('srcSamples'))}">${samples.map((s, i) => `<option value="s:${i}">${esc(tr(s.label))}</option>`).join('')}</optgroup>
        ${recordings.length ? `<optgroup label="${esc(t('srcRecordings'))}">${recordings.map(r => `<option value="r:${r.id}">${esc(r.meta?.title || r.author?.displayName)}</option>`).join('')}</optgroup>` : ''}
        <optgroup label="${esc(t('srcYours'))}"><option value="own">${t('srcOwnFile')}</option><option value="mic">${t('micSource')}</option></optgroup>
      </select>
    </label>
    <label class="own-file" hidden>${t('ownFile')}<input type="file" accept="audio/*"></label>
    <p class="warn" hidden>${t('headphones')}</p>
    <div class="player-row">
      <button type="button" class="play">${t('play')}</button>
      <button type="button" class="stop">${t('stop')}</button>
      <label class="check"><input type="checkbox" class="loop"> ${t('loop')}</label>
      <label class="vol">${t('volume')}<input type="range" class="volume" min="0" max="1.5" step="0.01" value="1"></label>
    </div>
    <p class="status" aria-live="polite"></p>`;
  const q = s => el.querySelector(s);
  const status = msg => (q('.status').textContent = msg || '');
  const sync = () => { const v = q('.src-pick').value; q('.own-file').hidden = v !== 'own'; q('.warn').hidden = v !== 'mic'; };
  q('.src-pick').onchange = sync; sync();
  q('.volume').oninput = e => auraliser?.setVolume(Number(e.target.value));
  q('.stop').onclick = () => { stopAll(); status(''); };
  q('.play').onclick = async () => {
    try {
      status(t('loading'));
      const a = player();
      a.setVolume(Number(q('.volume').value));
      a.setIR(await loadIR(ir), ir.irInfo?.format || 'mono', ir.irInfo?.rotationDeg || 0);
      const v = q('.src-pick').value;
      if (v === 'mic') { await a.startMic(); status(t('micOn')); return; }
      let buf;
      if (v.startsWith('s:')) buf = await loadBuffer(samples[Number(v.slice(2))].url);
      else if (v.startsWith('r:')) buf = await loadBuffer(recordings.find(r => r.id === v.slice(2)).media.url);
      else {
        const f = q('.own-file input').files[0];
        if (!f) { status(t('ownFile') + ' ?'); return; }
        buf = await audioContext().decodeAudioData(await f.arrayBuffer());
      }
      a.playSample(buf, q('.loop').checked);
      status('');
    } catch (e) { console.warn(e); status(`${t('audioError')} (${e.message})`); }
  };
}

// EDC + room-acoustic parameters for one IR, drawn into a canvas and a table inside `el`.
export async function mountAnalysis(el, ir, t) {
  el.innerHTML = `<h3>${t('analysis')}</h3><canvas class="edc" width="600" height="220"></canvas><table class="params"></table>`;
  let buf;
  try { buf = await loadIR(ir); } catch { el.querySelector('.params').innerHTML = `<tr><td>${t('audioError')}</td></tr>`; return; }
  const r = analyseIR(buf.getChannelData(0), buf.sampleRate);
  const cv = el.querySelector('canvas'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, n = r.edc.length, dbMin = -70;
  const grad = g.createLinearGradient(0, 0, W, 0);
  ['#8b9dff', '#36c5f0', '#3ddc97', '#ffd23f', '#ff8a3d', '#ff5ea8'].forEach((c, i, a) => grad.addColorStop(i / (a.length - 1), c));
  g.clearRect(0, 0, W, H); g.strokeStyle = grad; g.lineWidth = 2; g.beginPath();
  for (let px = 0; px < W; px++) {
    const v = Math.max(dbMin, r.edc[Math.floor(px / W * (n - 1))]);
    px ? g.lineTo(px, (v / dbMin) * H) : g.moveTo(px, (v / dbMin) * H);
  }
  g.stroke();
  const f = (v, d, u) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + u);
  el.querySelector('.params').innerHTML = `
    <tr><th>EDT</th><td>${f(r.EDT, 2, ' s')}</td><th>T20</th><td>${f(r.T20, 2, ' s')}</td><th>T30</th><td>${f(r.T30, 2, ' s')}</td></tr>
    <tr><th>C50</th><td>${f(r.C50, 1, ' dB')}</td><th>C80</th><td>${f(r.C80, 1, ' dB')}</td><th>D50</th><td>${f(r.D50 * 100, 0, ' %')}</td></tr>`;
}
