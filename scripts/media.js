// Upload limits and in-browser fixes, so storage stays small and bounded:
// images JPEG/PNG under a size limit (else: compress), sounds MP3/WAV/AIFF under 5 min and a size limit
// (else: trim / convert to MP3 or 16-bit WAV; AIFF always becomes WAV because Chrome cannot play AIFF).
// checkFile() returns { ok, problems: [i18n keys], fixes: [{ key, run: async () => File }] }.

export const DEFAULT_LIMITS = {
  photoMaxMB: 2, panoMaxMB: 6, soundMaxMB: 10, maxSoundSec: 300, textMax: 1000,
  perPlace: { images: 3, sounds: 3, texts: 5 },
};
export const GROUP = { photo: 'images', pano: 'images', audio: 'sounds', ir: 'sounds', text: 'texts' };

const MB = 1024 * 1024;
const ext = f => (f.name.split('.').pop() || '').toLowerCase();
const isImage = f => ['image/jpeg', 'image/png'].includes(f.type) || ['jpg', 'jpeg', 'png'].includes(ext(f));
const isAiff = f => /aif/.test(f.type) || ['aif', 'aiff', 'aifc'].includes(ext(f));
const isSound = f => isAiff(f) || ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(f.type) || ['mp3', 'wav'].includes(ext(f));
const rename = (name, newExt) => name.replace(/\.[^.]+$/, '') + '.' + newExt;
export const fmtMB = b => (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' Mo';

// ---------- images ----------
async function compressImage(file, maxPx, maxBytes) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  for (const q of [0.88, 0.8, 0.72, 0.64, 0.55]) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob.size <= maxBytes || q === 0.55) return new File([blob], rename(file.name, 'jpg'), { type: 'image/jpeg' });
  }
}

// ---------- sounds ----------
let ctx = null;
const audioCtx = () => (ctx ??= new AudioContext());

// Minimal AIFF / AIFF-C (uncompressed "NONE"/"sowt") reader → { sampleRate, channels: Float32Array[] }.
function parseAiff(buf) {
  const v = new DataView(buf);
  const id = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (id(0) !== 'FORM' || !['AIFF', 'AIFC'].includes(id(8))) throw new Error('not AIFF');
  let nch, frames, bits, rate, data, little = false;
  for (let o = 12; o + 8 <= v.byteLength;) {
    const ck = id(o), size = v.getUint32(o + 4);
    if (ck === 'COMM') {
      nch = v.getUint16(o + 8); frames = v.getUint32(o + 10); bits = v.getUint16(o + 14);
      const e = v.getUint16(o + 16) & 0x7fff, hi = v.getUint32(o + 18), lo = v.getUint32(o + 22);
      rate = (hi * 2 ** -31 + lo * 2 ** -63) * 2 ** (e - 16383);          // 80-bit IEEE extended
      if (id(8) === 'AIFC') { const comp = id(o + 26); if (comp === 'sowt') little = true; else if (comp !== 'NONE') throw new Error('compressed AIFF-C'); }
    } else if (ck === 'SSND') data = o + 16 + v.getUint32(o + 8);
    o += 8 + size + (size & 1);
  }
  const bps = bits / 8, chans = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) {
    const p = data + (i * nch + c) * bps; let s;
    if (bits === 8) s = v.getInt8(p) / 128;
    else if (bits === 16) s = v.getInt16(p, little) / 32768;
    else if (bits === 24) { const b0 = v.getUint8(p), b1 = v.getUint8(p + 1), b2 = v.getUint8(p + 2); let x = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2; if (x & 0x800000) x -= 0x1000000; s = x / 8388608; }
    else s = v.getInt32(p, little) / 2147483648;
    chans[c][i] = s;
  }
  return { sampleRate: rate, channels: chans };
}

async function decodeSound(file) {
  const ab = await file.arrayBuffer();
  if (isAiff(file)) return parseAiff(ab);
  const b = await audioCtx().decodeAudioData(ab);
  return { sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)) };
}

export function encodeWav({ sampleRate, channels }, bits = 16) {
  const n = channels[0].length, nch = channels.length, bps = bits / 8;
  const buf = new ArrayBuffer(44 + n * nch * bps), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nch * bps, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true); v.setUint32(24, Math.round(sampleRate), true);
  v.setUint32(28, Math.round(sampleRate) * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, n * nch * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++, o += bps) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    if (bits === 16) v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
    else { const x = Math.round(s < 0 ? s * 8388608 : s * 8388607); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  return (lameLoading ??= new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js' });
    s.onload = () => res(window.lamejs); s.onerror = () => rej(new Error('MP3 encoder failed to load'));
    document.head.append(s);
  }));
}

// MP3 at 128 kbps (stereo) / 96 kbps (mono); more than 2 channels are mixed down to stereo.
export async function encodeMp3({ sampleRate, channels }) {
  const lame = await loadLame();
  const rate = [48000, 44100, 32000].includes(Math.round(sampleRate)) ? Math.round(sampleRate) : null;
  if (!rate) throw new Error('unsupported sample rate for MP3: ' + sampleRate);
  const L = channels[0], R = channels.length > 1 ? channels[1] : null;
  const nch = R ? 2 : 1, enc = new lame.Mp3Encoder(nch, rate, nch === 2 ? 128 : 96);
  const toI16 = a => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) { const s = Math.max(-1, Math.min(1, a[i])); o[i] = s < 0 ? s * 32768 : s * 32767; } return o; };
  const l16 = toI16(L), r16 = R ? toI16(R) : null, out = [];
  for (let i = 0; i < l16.length; i += 1152) {
    const chunk = r16 ? enc.encodeBuffer(l16.subarray(i, i + 1152), r16.subarray(i, i + 1152)) : enc.encodeBuffer(l16.subarray(i, i + 1152));
    if (chunk.length) out.push(new Uint8Array(chunk));
  }
  const end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
  return new Blob(out, { type: 'audio/mpeg' });
}

const trim = (snd, sec) => ({ ...snd, channels: snd.channels.map(c => c.subarray(0, Math.round(sec * snd.sampleRate))) });

// ---------- main check ----------
export async function checkFile(type, file, limits = DEFAULT_LIMITS) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (type === 'photo' || type === 'pano') {
    if (!isImage(file)) return { ok: false, problems: ['lim_imageType'], fixes: [] };
    const max = (type === 'pano' ? L.panoMaxMB : L.photoMaxMB) * MB;
    if (file.size <= max) return { ok: true, problems: [], fixes: [] };
    return { ok: false, problems: ['lim_imageBig'], info: { size: file.size, max }, fixes: [
      { key: 'fix_compress', run: () => compressImage(file, type === 'pano' ? 5760 : 2560, max) }] };
  }
  if (type === 'audio' || type === 'ir') {
    if (!isSound(file)) return { ok: false, problems: ['lim_soundType'], fixes: [] };
    let snd;
    try { snd = await decodeSound(file); } catch (e) { console.warn(e); return { ok: false, problems: ['lim_soundUnreadable'], fixes: [] }; }
    const dur = snd.channels[0].length / snd.sampleRate, max = L.soundMaxMB * MB;
    // +0.5 s tolerance: MP3 encoding pads a few ms, so a file trimmed to exactly the limit must still pass.
    const problems = [], long = dur > L.maxSoundSec + 0.5, big = file.size > max, aiff = isAiff(file);
    if (long) problems.push('lim_soundLong');
    if (big) problems.push('lim_soundBig');
    if (aiff) problems.push('lim_aiff');
    if (!problems.length) return { ok: true, problems, fixes: [], info: { dur } };
    // One combined fix: trim if too long, then encode (IR: lossless 16-bit WAV keeps every channel; recordings: MP3).
    const run = async () => {
      const s = long ? trim(snd, L.maxSoundSec - 0.25) : snd;
      if (type === 'ir' || (!big && !long && aiff)) return new File([encodeWav(s, 16)], rename(file.name, 'wav'), { type: 'audio/wav' });
      const mp3 = await encodeMp3(s).catch(() => null);
      return mp3 ? new File([mp3], rename(file.name, 'mp3'), { type: 'audio/mpeg' }) : new File([encodeWav(s, 16)], rename(file.name, 'wav'), { type: 'audio/wav' });
    };
    const key = long ? 'fix_trimConvert' : type === 'ir' || (aiff && !big) ? 'fix_toWav' : 'fix_toMp3';
    return { ok: false, problems, info: { dur, size: file.size, max }, fixes: [{ key, run }] };
  }
  return { ok: true, problems: [], fixes: [] };
}

// After a fix, re-check the produced file (it must now pass, e.g. under the size limit).
export async function fixAndCheck(type, fix, limits) {
  const f = await fix.run();
  return { file: f, check: await checkFile(type, f, limits) };
}
