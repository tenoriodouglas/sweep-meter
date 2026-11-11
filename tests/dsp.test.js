import { test } from "node:test";
import assert from "node:assert/strict";
import * as d from "../app/src/main/assets/js/dsp.js";

const SR = 48000;

// Deterministic PRNG so tests never flake.
function rng(seed = 1) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function convolveFIR(x, ir) {
  const N = d.nextPow2(x.length + ir.length), ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(x); br.set(ir); d.fft(ar, ai); d.fft(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; }
  d.fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, x.length + ir.length));
}

test("full-scale sine reads 0 dBFS in its third-octave band", () => {
  const n = 8192, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / SR);
  const { P, df } = d.powerSpectrum(x, SR);
  const band = d.bandLevels(P, df).find(b => b.fc === 1000);
  assert.ok(Math.abs(band.db) < 0.5, `got ${band.db}`);
  assert.ok(Math.abs(d.overallLevel(P, df)) < 0.5);
});

test("A-weighting matches IEC reference values", () => {
  assert.ok(Math.abs(d.weighting(1000, "A")) < 0.1);
  assert.ok(Math.abs(d.weighting(100, "A") + 19.1) < 0.2);
  assert.ok(Math.abs(d.weighting(100, "C") + 0.3) < 0.2);
});

test("dominant frequency is resolved below 0.1 Hz with zero padding", () => {
  const n = 16384, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 823.37 * i / SR);
  const { P, df } = d.powerSpectrum(x, SR, 65536);
  assert.ok(Math.abs(d.dominant(P, df, 200, 5000).f - 823.37) < 0.1);
});

test("sweep deconvolution recovers delay and harmonic distortion", () => {
  const f1 = 30, f2 = 16000, T = 4, sweep = d.makeSweep(SR, f1, f2, T);
  const delay = 4800, x = new Float32Array(sweep.length + 2 * SR);
  // Memoryless nonlinearity: y = s + 0.1·s² with s = 0.5·sweep → H2 = 2.5 %.
  for (let i = 0; i < sweep.length; i++) { const s = 0.5 * sweep[i]; x[i + delay] = s + 0.1 * s * s; }
  const { h, peak } = d.deconvolve(x, sweep);
  assert.equal(peak, delay);
  const pre = Math.round((d.harmonicOffset(5, f1, f2, T) + 0.05) * SR);
  const ir = d.extractIR(h, peak, pre, SR);
  const dist = d.distortion(ir, pre, SR, { f1, f2, dur: T });
  const h2 = dist.harmonics[0].rel, i1k = d.GRID.findIndex(f => f >= 1000);
  assert.ok(Math.abs(h2[i1k] - d.db20(0.025)) < 1.5, `H2 at 1 kHz = ${h2[i1k]} dB`);
});

test("third harmonic level from a cubic nonlinearity", () => {
  const f1 = 30, f2 = 16000, T = 4, sweep = d.makeSweep(SR, f1, f2, T), x = new Float32Array(sweep.length + SR);
  for (let i = 0; i < sweep.length; i++) { const s = 0.5 * sweep[i]; x[i + 1000] = s + 0.1 * s * s * s; }
  const { h, peak } = d.deconvolve(x, sweep);
  const pre = Math.round((d.harmonicOffset(5, f1, f2, T) + 0.05) * SR);
  const dist = d.distortion(d.extractIR(h, peak, pre, SR), pre, SR, { f1, f2, dur: T });
  const i1k = d.GRID.findIndex(f => f >= 1000);
  const expected = d.db20(0.1 * 0.125 / 4 / (0.5 + 0.1 * 0.125 * 0.75));
  assert.ok(Math.abs(dist.harmonics[1].rel[i1k] - expected) < 1.5, `H3 ${dist.harmonics[1].rel[i1k]} vs ${expected}`);
});

test("decay analysis recovers RT60 of exponential noise", () => {
  const rt = 0.6, len = Math.round(2 * SR), x = new Float32Array(len), r = rng(7);
  for (let i = 0; i < len; i++) {
    const g = 10 ** (-3 * (i / SR) / rt);
    x[i] = (r() * 2 - 1) * g + (r() * 2 - 1) * 1e-4;
  }
  const res = d.decayAnalysis(x, SR);
  assert.ok(Math.abs(res.t30.t60 - rt) / rt < 0.05, `T30 ${res.t30.t60}`);
  assert.ok(Math.abs(res.edt.t60 - rt) / rt < 0.1, `EDT ${res.edt.t60}`);
  assert.ok(res.t30.r < -0.99);
});

test("octave band decay isolates a band-limited decay", () => {
  const len = Math.round(1.5 * SR), x = new Float32Array(len), r = rng(3);
  for (let i = 0; i < len; i++) x[i] = (r() * 2 - 1) * 10 ** (-3 * (i / SR) / 0.4);
  const ac = d.roomAcoustics(x, 0, SR, 1.5);
  const b1k = ac.bands.find(b => b.fc === 1000);
  assert.ok(Math.abs(d.bestRT(b1k) - 0.4) < 0.04, `1k RT ${d.bestRT(b1k)}`);
});

test("auto-EQ flattens a resonance", () => {
  const curve = Float64Array.from(d.GRID, f => 10 / (1 + ((f / 50 - 50 / f) * 6) ** 2));
  const target = d.targetCurve("flat", 0);
  const { filters, corrected } = d.autoEq(curve, target, { lo: 20, hi: 300 });
  assert.ok(filters.length >= 1);
  assert.ok(Math.abs(filters[0].fc - 50) < 3);
  assert.ok(d.maxIn(corrected, 20, 300) < 2.5);
});

test("room modes: first axial mode of a 4.2 m room", () => {
  const modes = d.roomModes(4.2, 3.1, 2.6, 200, 343);
  assert.ok(Math.abs(modes[0].f - 343 / (2 * 4.2)) < 1e-9);
  assert.equal(modes[0].type, "axial");
  assert.ok(modes.some(m => m.type === "oblique"));
});

test("tap analysis finds glass fundamental and Q", () => {
  const rec = new Float32Array(3 * SR), t0 = SR / 2;
  for (const [f, q, a] of [[823.4, 1500, 0.4], [2140, 900, 0.12]]) {
    const tau = q / (Math.PI * f);
    for (let i = t0; i < rec.length; i++) { const t = (i - t0) / SR; rec[i] += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t); }
  }
  const r = d.analyzeTap(rec, SR);
  assert.ok(Math.abs(r.f0 - 823.4) < 0.1);
  assert.ok(Math.abs(r.q - 1500) / 1500 < 0.05);
  assert.ok(r.peaks.some(p => Math.abs(p.f - 2140) < 1));
});

test("notes, calibration files and WAV encoding", () => {
  const n = d.noteOf(440);
  assert.equal(n.name + n.octave, "A4");
  assert.ok(Math.abs(d.noteOf(446).cents - 23.5) < 0.5);
  const cal = d.parseCal('"Sens Factor =-1.378dB, SERNO: 7001234"\n10 -2.5\n1000 0\n20000 3.1\n');
  assert.equal(cal.sens, -1.378);
  assert.ok(Math.abs(d.calAt(cal, 1000)) < 1e-9);
  assert.equal(d.wavFloat32(new Float32Array(10), SR).byteLength, 84);
});

test("deconvolution of a convolved room IR keeps its shape", () => {
  const sweep = d.makeSweep(SR, 30, 16000, 3), room = new Float32Array(SR / 2);
  room[100] = 1; room[1500] = 0.5;
  const { h, peak } = d.deconvolve(convolveFIR(sweep, room), sweep);
  assert.equal(peak, 100);
  assert.ok(Math.abs(h[1500] / h[100] - 0.5) < 0.05);
});
