// IR analysis: Schroeder decay, EDT/T20/T30, C50/C80/D50, and raw-impulse cleanup.
// Pure functions on Float32Array — no DOM, so they also run under Node for tests.

// Onset = first sample reaching 20 dB below the peak (ISO 3382 style start point).
export function findOnset(x, thresholdDb = -20) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const thr = peak * Math.pow(10, thresholdDb / 20);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= thr) return i;
  return 0;
}

// Schroeder backward integral, in dB normalised to 0 at t=0.
export function schroederDb(x) {
  const edc = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) { acc += x[i] * x[i]; edc[i] = acc; }
  const total = edc[0] || 1;
  const db = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) db[i] = 10 * Math.log10(edc[i] / total + 1e-30);
  return db;
}

// Least-squares slope (dB/s) of the EDC between two levels; returns RT = -60/slope.
function decayTime(edcDb, fs, fromDb, toDb) {
  let i0 = -1, i1 = -1;
  for (let i = 0; i < edcDb.length; i++) {
    if (i0 < 0 && edcDb[i] <= fromDb) i0 = i;
    if (edcDb[i] <= toDb) { i1 = i; break; }
  }
  if (i0 < 0 || i1 <= i0 + 1) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const n = i1 - i0 + 1;
  for (let i = i0; i <= i1; i++) {
    const t = i / fs, y = edcDb[i];
    sx += t; sy += y; sxx += t * t; sxy += t * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope < 0 ? -60 / slope : null;
}

function energyRatio(x, fs, ms) {
  const k = Math.min(x.length, Math.round(fs * ms / 1000));
  let early = 0, late = 0;
  for (let i = 0; i < x.length; i++) (i < k ? (early += x[i] * x[i]) : (late += x[i] * x[i]));
  return { early, late };
}

// x: mono IR (use W for ambisonics). Returns seconds and dB; null when the decay range is too short.
export function analyseIR(x, fs) {
  const ir = x.subarray(findOnset(x));
  const edc = schroederDb(ir);
  const c50 = energyRatio(ir, fs, 50), c80 = energyRatio(ir, fs, 80);
  return {
    edc,
    EDT: decayTime(edc, fs, 0, -10),
    T20: decayTime(edc, fs, -5, -25),
    T30: decayTime(edc, fs, -5, -35),
    C50: 10 * Math.log10(c50.early / (c50.late || 1e-30)),
    C80: 10 * Math.log10(c80.early / (c80.late || 1e-30)),
    D50: c50.early / (c50.early + c50.late),
  };
}

// Clap/balloon recording → usable IR: trim 2 ms before onset, cut where the EDC falls below
// floorDb, fade the last 10 ms, normalise to peak 1. Works on every channel with the same cut.
export function cleanImpulse(channels, fs, { preMs = 2, floorDb = -60 } = {}) {
  const ref = channels[0];
  const start = Math.max(0, findOnset(ref) - Math.round(fs * preMs / 1000));
  const edc = schroederDb(ref.subarray(start));
  let end = edc.length;
  for (let i = 0; i < edc.length; i++) if (edc[i] < floorDb) { end = i; break; }
  const fade = Math.min(end, Math.round(fs * 0.01));
  let peak = 0;
  const out = channels.map(c => {
    const y = c.slice(start, start + end);
    for (let i = 0; i < fade; i++) y[end - 1 - i] *= i / fade;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    return y;
  });
  if (peak > 0) for (const y of out) for (let i = 0; i < y.length; i++) y[i] /= peak;
  return out;
}
