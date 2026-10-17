// Impulse-response processing before upload: sweep deconvolution, alignment (pre-delay removal), tail trim, normalisation.
// Pure functions on { sampleRate, channels: Float32Array[] } — no DOM, so they are unit-tested under Deno.
import { findOnset } from './irAnalysis.js';

// ---------- FFT (iterative radix-2, in place, complex as two Float64Arrays) ----------
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const nextPow2 = n => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
function spectrum(x, n) { const re = new Float64Array(n), im = new Float64Array(n); re.set(x.subarray(0, Math.min(x.length, n))); fft(re, im); return [re, im]; }

// ---------- exponential sine sweep (Farina) ----------
// x(t) = sin(2π f1 L (e^{t/L} − 1)), L = T / ln(f2/f1), with 20 ms raised-cosine fades — identical to assets/samples/sweep.wav.
export const METIS_SWEEP = { f1: 100, f2: 8000, duration: 1.5 };
export function essSweep({ f1, f2, duration }, fs, fadeMs = 20) {
  const n = Math.round(duration * fs), L = duration / Math.log(f2 / f1), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f1 * L * (Math.exp(i / fs / L) - 1));
  const f = Math.round(fadeMs / 1000 * fs);
  for (let i = 0; i < f; i++) { const w = i / f; x[i] *= w; x[n - 1 - i] *= w; }
  return x;
}
// Inverse filter: time-reversed sweep with a −6 dB/octave amplitude envelope, so sweep * inverse ≈ band-limited impulse.
function essInverse(p, fs) {
  const x = essSweep(p, fs), n = x.length, L = p.duration / Math.log(p.f2 / p.f1), inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = x[n - 1 - i] * Math.exp(-(i / fs) / L);
  // scale so that the deconvolved peak of a unit system ≈ 1
  const [r1, i1] = spectrum(x, nextPow2(2 * n)), [r2, i2] = spectrum(inv, r1.length);
  let mid = 0, cnt = 0; const k1 = Math.ceil(p.f1 * 2 / fs * r1.length), k2 = Math.floor(p.f2 / 2 / fs * r1.length);
  for (let k = k1; k < k2; k++) { mid += Math.hypot(r1[k] * r2[k] - i1[k] * i2[k], r1[k] * i2[k] + i1[k] * r2[k]); cnt++; }
  const g = cnt ? cnt / mid : 1;
  for (let i = 0; i < n; i++) inv[i] *= g;
  return inv;
}

// Linear convolution of every channel with a filter (FFT). Returns full-length results.
function convolveAll(channels, h) {
  const n = nextPow2(channels[0].length + h.length), [hr, hi] = spectrum(h, n);
  return channels.map(x => {
    const [re, im] = spectrum(x, n);
    for (let k = 0; k < n; k++) { const r = re[k] * hr[k] - im[k] * hi[k]; im[k] = re[k] * hi[k] + im[k] * hr[k]; re[k] = r; }
    fft(re, im, true);
    return Float32Array.from(re.subarray(0, channels[0].length + h.length - 1));
  });
}

// Deconvolution with a known ESS (parametric) — returns the full result; the linear IR starts ~ sweep length in.
export function deconvolveESS(snd, params) {
  return { ...snd, channels: convolveAll(snd.channels, essInverse(params, snd.sampleRate)) };
}

// Deconvolution with the original excitation file: regularised spectral division H = Y·X* / (|X|² + ε·max|X|²).
export function deconvolveReference(snd, reference, epsilonDb = -40) {
  const x = reference.channels[0], n = nextPow2(snd.channels[0].length + x.length);
  const [xr, xi] = spectrum(x, n);
  let maxP = 0; for (let k = 0; k < n; k++) maxP = Math.max(maxP, xr[k] * xr[k] + xi[k] * xi[k]);
  const eps = maxP * 10 ** (epsilonDb / 10);
  return { ...snd, channels: snd.channels.map(y => {
    const [re, im] = spectrum(y, n);
    for (let k = 0; k < n; k++) {
      const d = xr[k] * xr[k] + xi[k] * xi[k] + eps;
      const r = (re[k] * xr[k] + im[k] * xi[k]) / d; im[k] = (im[k] * xr[k] - re[k] * xi[k]) / d; re[k] = r;
    }
    fft(re, im, true);
    return Float32Array.from(re.subarray(0, snd.channels[0].length));
  }) };
}

// ---------- alignment, tail, gain ----------
const peakIndex = chans => { let m = 0, at = 0; for (const c of chans) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > m) { m = Math.abs(c[i]); at = i; } return at; };

// Remove everything before the attack (keeping preMs), same cut on all channels. Returns { snd, removedMs }.
export function removePredelay(snd, preMs = 2) {
  // Onset on the loudest channel, searched up to the peak (ignores deconvolution harmonics far before the main peak).
  const pk = peakIndex(snd.channels);
  const ref = snd.channels.reduce((a, c) => (Math.abs(c[pk]) > Math.abs(a[pk]) ? c : a));
  const win = Math.round(0.05 * snd.sampleRate), from = Math.max(0, pk - win);
  const start = Math.max(0, from + findOnset(ref.subarray(from, pk + 1)) - Math.round(preMs / 1000 * snd.sampleRate));
  return { snd: { ...snd, channels: snd.channels.map(c => c.slice(start)) }, removedMs: (start / snd.sampleRate) * 1000 };
}

// Cut where the decay comes within `marginDb` of the noise floor (default +3 dB; higher = earlier cut), then fade the last 10 ms.
// Returns { snd, lengthS }.
// The noise floor is the median 10 ms energy over the last 20 % of the signal *that is not digital silence*
// (deconvolution leaves long near-zero stretches at the end, which would otherwise make the floor look far too low).
export function trimTail(snd, fadeMs = 10, marginDb = 3) {
  const fs = snd.sampleRate, w = Math.max(1, Math.round(0.01 * fs)), c = snd.channels[0];
  const env = []; for (let i = 0; i + w <= c.length; i += w) { let e = 0; for (let j = 0; j < w; j++) e += c[i + j] ** 2; env.push(e / w); }
  if (env.length < 10) return { snd, lengthS: c.length / fs };
  let pk = 0; for (let k = 1; k < env.length; k++) if (env[k] > env[pk]) pk = k;
  let last = env.length - 1; while (last > pk && env[last] < env[pk] * 1e-14) last--;      // drop trailing silence (< −140 dB)
  const from = pk + Math.floor((last - pk) * 0.8);
  const tail = env.slice(from, last + 1).sort((a, b) => a - b);
  const noise = tail[Math.floor(tail.length / 2)] || env[pk] * 1e-14;
  let k = pk;
  const thr = noise * 10 ** (marginDb / 10);
  while (k < env.length && env[k] > thr) k++;
  const end = Math.min(c.length, (k + 1) * w), f = Math.min(end, Math.round(fadeMs / 1000 * fs));
  const channels = snd.channels.map(ch => { const y = ch.slice(0, end); for (let i = 0; i < f; i++) y[end - 1 - i] *= i / f; return y; });
  return { snd: { ...snd, channels }, lengthS: end / fs };
}

export function normalize(snd, peakDb = -1) {
  let m = 0; for (const c of snd.channels) for (const v of c) m = Math.max(m, Math.abs(v));
  if (!m) return snd;
  const g = 10 ** (peakDb / 20) / m;
  return { ...snd, channels: snd.channels.map(c => c.map(v => v * g)) };
}

// Full chain, in the order that makes sense: deconvolve → align → trim → normalise.
// opts: { deconv: null | { kind: 'ess', params } | { kind: 'reference', reference }, align, trim, normalize }
export function processIR(snd, opts) {
  let s = snd; const report = { steps: [] };
  if (opts.deconv?.kind === 'ess') { s = deconvolveESS(s, opts.deconv.params); report.steps.push('deconv'); }
  if (opts.deconv?.kind === 'reference') {
    if (opts.deconv.reference.sampleRate !== s.sampleRate) throw new Error(`sample rates differ (${opts.deconv.reference.sampleRate} vs ${s.sampleRate} Hz)`);
    s = deconvolveReference(s, opts.deconv.reference); report.steps.push('deconv');
  }
  // After a deconvolution the IR always needs aligning (it sits ~ one sweep length in), whatever the checkbox says.
  if (opts.align || opts.deconv) {
    const r = removePredelay(s); s = r.snd; report.steps.push('align');
    // ESS deconvolution itself shifts the IR by (inverse-filter length − 1) samples; report only the acoustic pre-delay.
    const shift = opts.deconv?.kind === 'ess' ? (Math.round(opts.deconv.params.duration * snd.sampleRate) - 1) / snd.sampleRate * 1000 : 0;
    report.removedMs = Math.max(0, r.removedMs - shift);
  }
  if (opts.trim || opts.deconv) { const r = trimTail(s, 10, opts.trimMarginDb ?? 3); s = r.snd; report.steps.push('trim'); report.trimMarginDb = opts.trimMarginDb ?? 3; }
  if (opts.normalize) { s = normalize(s); report.steps.push('normalize'); }
  report.lengthS = s.channels[0].length / s.sampleRate;
  return { snd: s, report };
}
