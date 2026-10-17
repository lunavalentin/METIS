// Synthetic test: exponentially decaying noise with known RT60 → T20/T30/EDT should recover it.
// Run: deno run tests/irAnalysis.test.mjs   (or node)
import { analyseIR, cleanImpulse, findOnset } from '../scripts/irAnalysis.js';

let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const fs = 48000, rt = 1.2, pre = 0.1;
const x = new Float32Array(Math.round(fs * (pre + 3)));
for (let i = Math.round(fs * pre); i < x.length; i++) {
  const t = i / fs - pre;
  x[i] = rnd() * Math.pow(10, (-60 * t / rt) / 20); // -60 dB per rt seconds
}
const r = analyseIR(x, fs);
const ok = (name, v, lo, hi) => {
  const pass = v !== null && v >= lo && v <= hi;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} = ${v === null ? 'null' : v.toFixed(3)} (expected ${lo}–${hi})`);
  if (!pass) globalThis.failed = true;
};
ok('T30', r.T30, rt * 0.95, rt * 1.05);
ok('T20', r.T20, rt * 0.95, rt * 1.05);
ok('EDT', r.EDT, rt * 0.9, rt * 1.1);
// Analytic C80 for pure exponential energy decay: 10log10(1/(e^{-k·0.08}) - 1), k = 6 ln10 / rt
const k = 6 * Math.LN10 / rt, c80 = 10 * Math.log10(1 / Math.exp(-k * 0.08) - 1);
ok('C80', r.C80, c80 - 0.5, c80 + 0.5);
ok('D50', r.D50, 0, 1);
ok('onset (s)', findOnset(x) / fs, pre - 0.001, pre + 0.002);
const [c] = cleanImpulse([x], fs);
ok('clean starts ≤2 ms before onset (s)', findOnset(c) / fs, 0, 0.0025);
ok('clean peak', Math.max(...c.map(Math.abs)), 0.999, 1.001);
ok('clean shorter than input (s)', c.length / fs, 0.5, x.length / fs - 0.1);
if (globalThis.failed) throw new Error('tests failed');
