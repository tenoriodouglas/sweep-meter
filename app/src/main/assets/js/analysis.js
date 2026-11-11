// Measurement-level analysis with per-measurement caching.
import * as d from "./dsp.js";
import { settings } from "./ui.js";

const caches = new WeakMap();

function cached(m, key, fn) {
  if (!caches.has(m)) caches.set(m, new Map());
  const c = caches.get(m);
  if (!c.has(key)) c.set(key, fn());
  return c.get(key);
}

/** Drops cached results that depend on settings (calibration file). */
export function invalidate(m) { if (m) caches.delete(m); }

const calCorrection = curve => {
  const cal = settings.get("cal");
  if (!cal) return curve;
  return Float64Array.from(curve, (v, i) => v - d.calAt(cal, d.GRID[i]));
};

/** Raw gated response in dB on GRID (1/48 octave), mic calibration applied, NaN outside the sweep. */
export function rawResponse(m, win = settings.get("win")) {
  return cached(m, `raw:${win}:${settings.get("calName")}`, () => {
    let curve;
    if (m.kind === "avg") curve = Float64Array.from(m.curve); // already calibrated when averaged
    else {
      const { P, df } = d.gatedPower(m.ir, m.peak, m.sr, win);
      curve = calCorrection(d.smoothToGrid(P, df, 48));
    }
    const { f1, f2 } = m.sweep;
    for (let i = 0; i < curve.length; i++) if (d.GRID[i] < f1 || d.GRID[i] > f2) curve[i] = NaN;
    return curve;
  });
}

/** Display curve: smoothed, optionally referenced and normalized to 0 dB max. */
export function response(m, { win = settings.get("win"), frac = settings.get("smooth"), normalize = settings.get("normalize"), ref = null } = {}) {
  let c = d.smoothCurve(rawResponse(m, win), frac);
  if (ref) {
    const r = d.smoothCurve(rawResponse(ref, win), frac);
    c = Float64Array.from(c, (v, i) => v - r[i]);
  }
  if (normalize) {
    const top = d.maxIn(c, m.sweep.f1, m.sweep.f2);
    c = Float64Array.from(c, v => v - top);
  }
  return c;
}

/** Ranked resonances in the peak search range (1/24 octave). */
export function peaks(m, lo = settings.get("pLo"), hi = settings.get("pHi")) {
  const c = response(m, { frac: 24, normalize: true });
  return d.findPeaks(c, lo, hi);
}

/** Broadband decay (fast; used for summaries). */
export const broadbandDecay = m => (m.kind === "avg" ? null : cached(m, "bb", () => {
  const start = Math.max(0, m.peak - Math.round(0.001 * m.sr));
  return d.decayAnalysis(m.ir.subarray(start, Math.min(m.ir.length, start + 3 * m.sr)), m.sr);
}));

export const roomAcoustics = m => (m.kind === "avg" ? null : cached(m, "room", () => d.roomAcoustics(m.ir, m.peak, m.sr)));

/** Mid-band (500 Hz–1 kHz) reverberation time, the usual single-number RT60. */
export function midRT(m) {
  const ra = roomAcoustics(m);
  if (!ra) return NaN;
  const v = ra.bands.filter(b => b.fc === 500 || b.fc === 1000).map(d.bestRT).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : d.bestRT(ra.broadband);
}

export const waterfall = (m, preset) => cached(m, "wf:" + preset, () => {
  const p = preset === "mid" ? { t1: 0.05, win: 0.05, frac: 12 } : { t1: 0.3, win: 0.3, frac: 12 };
  const slices = d.waterfall(m.ir, m.peak, m.sr, { ...p, slices: 30 });
  const lo = preset === "mid" ? 100 : 20, hi = preset === "mid" ? 5000 : 300;
  const top = Math.max(...slices.map(s => d.maxIn(s.curve, lo, hi)));
  slices.forEach(s => { for (let i = 0; i < s.curve.length; i++) s.curve[i] -= top; });
  return slices;
});

export const distortion = m => (m.kind === "avg" ? null : cached(m, "dist", () => d.distortion(m.ir, m.peak, m.sr, m.sweep)));

export const impulseView = (m, ms) => cached(m, "imp:" + ms, () => {
  const from = Math.max(0, m.peak - Math.round(0.002 * m.sr)), to = Math.min(m.ir.length, m.peak + Math.round(ms / 1000 * m.sr));
  const t = new Float64Array(to - from), y = new Float64Array(to - from);
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(m.ir[i]));
  for (let i = 0; i < t.length; i++) { t[i] = (from + i - m.peak) / m.sr * 1000; y[i] = m.ir[from + i] / (peak || 1); }
  return { t, y, etc: d.etc(m.ir, from, to) };
});

/** Spatial average (power) of several measurements as a curve-only measurement. */
export function averageOf(ms, name) {
  const curves = ms.map(m => rawResponse(m, settings.get("win")));
  return {
    kind: "avg", name, date: Date.now(), sr: ms[0].sr, curve: d.averageCurves(curves),
    sweep: { f1: Math.max(...ms.map(m => m.sweep.f1)), f2: Math.min(...ms.map(m => m.sweep.f2)), dur: 0 },
    stats: { sources: ms.map(m => m.name) },
  };
}
