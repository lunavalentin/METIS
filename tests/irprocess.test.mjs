// Synthetic checks for scripts/irprocess.js. Run: deno run tests/irprocess.test.mjs
import { essSweep, METIS_SWEEP, processIR, removePredelay, normalize, trimTail, deconvolveESS } from '../scripts/irprocess.js';
import { analyseIR } from '../scripts/irAnalysis.js';

let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const fs = 48000, rt = 0.8, pre = 0.03;
// Ground truth: 30 ms silence, direct sound, exponentially decaying noise tail.
const h = new Float32Array(Math.round(fs * (pre + 1.6)));
const d0 = Math.round(pre * fs); h[d0] = 1;
for (let i = d0 + 48; i < h.length; i++) { const t = (i - d0) / fs; h[i] = 0.25 * rnd() * 10 ** (-3 * t / rt); }
// "Recording" of the METIS sweep through h (direct-form convolution is too slow → do it with the module's own FFT path via processIR? no: independent check, use naive overlap on a decimated grid is too slow; use a simple FFT here).
function fftConv(a, b) {
  const n = 2 ** Math.ceil(Math.log2(a.length + b.length));
  const fft = (re, im, inv) => { for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const ang = (inv ? 2 : -2) * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(ang * k), wi = Math.sin(ang * k), x = i + k, y = x + len / 2, tr = re[y] * wr - im[y] * wi, ti = re[y] * wi + im[y] * wr; re[y] = re[x] - tr; im[y] = im[x] - ti; re[x] += tr; im[x] += ti; } }
    if (inv) for (let i = 0; i < n; i++) re[i] /= n; };
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n); ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi); for (let k = 0; k < n; k++) { const r = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; }
  fft(ar, ai, true); return Float32Array.from(ar.subarray(0, a.length + b.length - 1));
}
const sweep = essSweep(METIS_SWEEP, fs);
const rec = fftConv(sweep, h); for (let i = 0; i < rec.length; i++) rec[i] += 1e-4 * rnd();
const snd = { sampleRate: fs, channels: [rec] };

const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail ?? ''}`); if (!cond) globalThis.failed = true; };
const corr = (a, b, n) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return ab / Math.sqrt(aa * bb); };
// Fair reference: the true IR seen through the same 100 Hz–8 kHz band (deconvolving the dry sweep gives that band-limiting kernel),
// aligned the same way. A full-band comparison would be meaningless: content above 8 kHz is not in the sweep.
const kernel = deconvolveESS({ sampleRate: fs, channels: [sweep] }, METIS_SWEEP).channels[0];
const truthBL = removePredelay({ sampleRate: fs, channels: [fftConv(h, kernel)] }).snd;
const truth = normalize(truthBL).channels[0];
const xcorr = (a, b, n, maxLag = 40) => { let best = { c: -1, lag: 0 }; for (let L = -maxLag; L <= maxLag; L++) { let ab = 0, aa = 0, bb = 0; for (let i = Math.max(0, -L); i < n; i++) { const x = a[i], y = b[i + L] ?? 0; ab += x * y; aa += x * x; bb += y * y; } const c = ab / Math.sqrt(aa * bb); if (c > best.c) best = { c, lag: L }; } return best; };
const T30 = x => analyseIR(x, fs).T30;

for (const [label, deconv] of [['ESS (METIS parameters)', { kind: 'ess', params: METIS_SWEEP }], ['reference file', { kind: 'reference', reference: { sampleRate: fs, channels: [sweep] } }]]) {
  const t0 = performance.now();
  const { snd: out, report } = processIR(snd, { deconv, align: true, trim: true, normalize: true });
  const y = out.channels[0], ms = (performance.now() - t0).toFixed(0);
  const c = corr(y, truth, Math.round(0.5 * fs)), x = xcorr(y, truth, Math.round(0.2 * fs));
  ok(`${label}: matches true IR (same band)`, x.c > 0.95 && Math.abs(x.lag) <= 8, `(best correlation ${x.c.toFixed(4)} at lag ${x.lag} samples = ${(x.lag / fs * 1000).toFixed(2)} ms; at lag 0: ${c.toFixed(4)}; ${ms} ms)`);
  const t30 = T30(y), t30t = T30(truth);
  ok(`${label}: T30`, Math.abs(t30 - t30t) / t30t < 0.05, `(${t30.toFixed(3)} s vs true ${t30t.toFixed(3)} s)`);
  ok(`${label}: peak −1 dBFS`, Math.abs(y.reduce((m, v) => Math.max(m, Math.abs(v)), 0) - 10 ** (-1 / 20)) < 1e-3);
  ok(`${label}: onset kept ≈ 2 ms`, Math.abs(y.findIndex(v => Math.abs(v) > 0.5) / fs * 1000 - 2) < 0.5, `(${(y.findIndex(v => Math.abs(v) > 0.5) / fs * 1000).toFixed(2)} ms)`);
  // Deconvolution gains a lot of SNR: the decay stays clean down to ≈ −114 dB at 1.6 s (end of the true IR; measured, see CHANGELOG),
  // then sinks into a −115…−150 dB floor. So: the cut must not fall inside the decay (≥ 1.3 s) and must remove part of the 3.1 s result.
  ok(`${label}: tail trimmed after the decay, before the end`, report.lengthS >= 1.3 && report.lengthS <= 2.8, `(${report.lengthS.toFixed(2)} s kept of ≈ 3.1 s)`);
}
const { removedMs } = removePredelay({ sampleRate: fs, channels: [h] });
ok('pre-delay removal on the true IR', Math.abs(removedMs - 28) < 0.5, `(${removedMs.toFixed(2)} ms removed, expected 28)`);
const tr = trimTail({ sampleRate: fs, channels: [Float32Array.from(h, (v, i) => v + 2e-3 * rnd())] });
// noise 2e-3 rms vs tail rms ≈ 0.144 → 37 dB of decay → meets the noise ≈ 0.8 × 37/60 ≈ 0.5 s after the 30 ms pre-delay
ok('tail trim with a noise floor at −54 dB', tr.lengthS > 0.45 && tr.lengthS < 0.75, `(kept ${tr.lengthS.toFixed(2)} s, expected ≈ 0.5–0.65 s)`);
// multichannel: same alignment on all channels
const mc = processIR({ sampleRate: fs, channels: [h, Float32Array.from(h, v => 0.5 * v)] }, { align: true, normalize: true });
ok('4ch/2ch: same cut on every channel', mc.snd.channels[0].length === mc.snd.channels[1].length);
if (globalThis.failed) throw new Error('tests failed');

// --- Ambisonics: a 4-channel (AmbiX W,Y,Z,X) IR must keep its channel count, its order and the ratios between channels ---
{
  const gains = [1, 0.6, -0.3, 0.75];                     // a source front-left and slightly below: Y>0, Z<0, X>0
  const foaIR = gains.map(g => Float32Array.from(h, v => v * g));
  const foaRec = gains.map(g => Float32Array.from(rec, v => v * g)); // same sweep recording, through the same IR, per channel
  const rms = c => Math.sqrt(c.reduce((a, v) => a + v * v, 0) / c.length);
  const ratios = chans => chans.map(c => Math.sign(c[c.reduce((bi, v, i, a) => (Math.abs(v) > Math.abs(a[bi]) ? i : bi), 0)]) * rms(c) / rms(chans[0]));
  for (const [label, input, opts] of [
    ['FOA IR: normalise + align + trim', { sampleRate: fs, channels: foaIR }, { normalize: true, align: true, trim: true }],
    ['FOA sweep: deconvolve (METIS) + all', { sampleRate: fs, channels: foaRec }, { deconv: { kind: 'ess', params: METIS_SWEEP }, normalize: true, align: true, trim: true }],
  ]) {
    const { snd: out } = processIR(input, opts);
    const r = ratios(out.channels), want = gains.map(g => g / gains[0]);
    const err = Math.max(...r.map((v, i) => Math.abs(v - want[i])));
    ok(`${label}: 4 channels, same length`, out.channels.length === 4 && out.channels.every(c => c.length === out.channels[0].length));
    ok(`${label}: channel ratios kept (W,Y,Z,X)`, err < 1e-3, `(got ${r.map(v => v.toFixed(3)).join(', ')}; want ${want.map(v => v.toFixed(3)).join(', ')})`);
    const pk = out.channels.reduce((m, c) => Math.max(m, c.reduce((a, v) => Math.max(a, Math.abs(v)), 0)), 0);
    ok(`${label}: one common gain (loudest channel at −1 dBFS)`, Math.abs(20 * Math.log10(pk) + 1) < 0.01, `(${(20 * Math.log10(pk)).toFixed(2)} dBFS)`);
  }
}
if (globalThis.failed) throw new Error('tests failed');
