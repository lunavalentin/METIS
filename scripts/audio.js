// Audio engine: convolution of a dry sample or the live mic with an IR, any format.
// FOA (AmbiX ACN/SN3D) → 4 mono convolvers → max-rE sampling decoder on an 8-speaker cube
// → HRTF PannerNodes. Head rotation = AudioListener orientation (driven by the 360 viewer).
// DRAFT — not yet tested in a browser.

let ctx = null;
export function audioContext() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export async function loadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio fetch ${res.status}: ${url}`);
  return audioContext().decodeAudioData(await res.arrayBuffer());
}

// FuMa (W,X,Y,Z; W at -3 dB) → AmbiX (W,Y,Z,X; SN3D). First order only.
export function fumaToAmbix(buf) {
  const c = audioContext();
  const out = c.createBuffer(4, buf.length, buf.sampleRate);
  const [w, x, y, z] = [0, 1, 2, 3].map(i => buf.getChannelData(i));
  const W = out.getChannelData(0);
  for (let i = 0; i < w.length; i++) W[i] = w[i] * Math.SQRT2;
  out.copyToChannel(y, 1); out.copyToChannel(z, 2); out.copyToChannel(x, 3);
  return out;
}

function monoBuffer(buf, ch) {
  const b = audioContext().createBuffer(1, buf.length, buf.sampleRate);
  b.copyToChannel(buf.getChannelData(ch), 0);
  return b;
}

// Cube vertices in ambisonic coords (X front, Y left, Z up).
const CUBE = [];
for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1])
  CUBE.push([x, y, z].map(v => v / Math.sqrt(3)));
const MAX_RE_1 = 1 / Math.sqrt(3); // first-order 3D max-rE weight

// Ambisonic (X,Y,Z) → Web Audio (x right, y up, z towards listener's back).
const toWebAudio = ([X, Y, Z]) => [-Y, Z, -X];

// Builds the IR-specific part of the graph. Returns { input, output, dispose }.
function buildChain(ir, format) {
  const c = audioContext();
  const input = c.createGain(), output = c.createGain();
  // Sources are treated as a point source: force a mono down-mix before convolution.
  input.channelCount = 1; input.channelCountMode = 'explicit';
  const nodes = [];

  if (format === 'foa-ambix' || format === 'foa-fuma') {
    const amb = format === 'foa-fuma' ? fumaToAmbix(ir) : ir;
    const merger = c.createChannelMerger(4);
    for (let ch = 0; ch < 4; ch++) {
      const conv = c.createConvolver();
      conv.normalize = false;
      conv.buffer = monoBuffer(amb, ch);
      input.connect(conv); conv.connect(merger, 0, ch); nodes.push(conv);
    }
    const split = c.createChannelSplitter(4);
    merger.connect(split);
    // ACN order: 0=W, 1=Y, 2=Z, 3=X
    for (const [x, y, z] of CUBE) {
      const sum = c.createGain(); sum.gain.value = 1 / CUBE.length;
      const coef = [1, 3 * MAX_RE_1 * y, 3 * MAX_RE_1 * z, 3 * MAX_RE_1 * x];
      coef.forEach((k, ch) => { const g = c.createGain(); g.gain.value = k; split.connect(g, ch); g.connect(sum); nodes.push(g); });
      const p = c.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'linear'; p.refDistance = 1; p.rolloffFactor = 0;
      const [px, py, pz] = toWebAudio([x, y, z]);
      p.positionX.value = px; p.positionY.value = py; p.positionZ.value = pz;
      sum.connect(p); p.connect(output); nodes.push(sum, p);
    }
    nodes.push(merger, split);
  } else {
    // mono / stereo / binaural: a single convolver (1 or 2 channels) is correct here.
    const conv = c.createConvolver();
    conv.normalize = false;
    conv.buffer = ir.numberOfChannels > 2 ? monoBuffer(ir, 0) : ir;
    input.connect(conv); conv.connect(output); nodes.push(conv);
  }
  return { input, output, dispose: () => [input, output, ...nodes].forEach(n => n.disconnect()) };
}

// Player: one IR loaded at a time, source = sample buffer or mic.
export class Auraliser {
  constructor() {
    const c = audioContext();
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.chain = null; this.source = null; this.micStream = null; this.yawOffset = 0;
  }

  setIR(irBuffer, format, rotationDeg = 0) {
    this.stop();
    if (this.chain) this.chain.dispose();
    this.chain = buildChain(irBuffer, format);
    this.chain.output.connect(this.master);
    this.yawOffset = rotationDeg;
    this.setOrientation(0, 0);
  }

  playSample(buffer, loop = false) {
    this.stop();
    const s = audioContext().createBufferSource();
    s.buffer = buffer; s.loop = loop;
    s.connect(this.chain.input); s.start();
    this.source = s;
  }

  async startMic() {
    this.stop();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.source = audioContext().createMediaStreamSource(this.micStream);
    this.source.connect(this.chain.input);
  }

  stop() {
    if (this.source) { try { this.source.stop?.(); } catch {} this.source.disconnect(); this.source = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
  }

  setVolume(v) { this.master.gain.value = v; }

  // yaw: degrees, positive = turning right (Pannellum convention). pitch: degrees, up positive.
  setOrientation(yawDeg, pitchDeg) {
    const l = audioContext().listener;
    const yaw = (yawDeg + this.yawOffset) * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
    // Forward in Web Audio coords: yaw 0 → (0,0,-1); turning right → +x.
    const f = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const u = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    if (l.forwardX) {
      [l.forwardX, l.forwardY, l.forwardZ].forEach((p, i) => (p.value = f[i]));
      [l.upX, l.upY, l.upZ].forEach((p, i) => (p.value = u[i]));
    } else {
      l.setOrientation(...f, ...u); // Firefox / older Safari
    }
  }
}
