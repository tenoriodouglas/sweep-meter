// Core signal processing for Sweep Meter. Pure functions, no DOM access.

/* ---------- Basics ---------- */

export function logspace(a, b, n) {
  const out = new Float64Array(n), la = Math.log(a), lb = Math.log(b);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + (lb - la) * i / (n - 1));
  return out;
}

/** Shared log-frequency grid for every stored and displayed curve. */
export const GRID = logspace(20, 20000, 720);

export const nextPow2 = n => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
export const db10 = x => 10 * Math.log10(x + 1e-30);
export const db20 = x => 20 * Math.log10(Math.abs(x) + 1e-15);

/** In-place iterative radix-2 complex FFT. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Linear interpolation of a curve sampled on a log grid. */
export function interpLog(grid, values, f) {
  if (f <= grid[0]) return values[0];
  const n = grid.length;
  if (f >= grid[n - 1]) return values[n - 1];
  const r = Math.log(f / grid[0]) / Math.log(grid[n - 1] / grid[0]) * (n - 1);
  const i = Math.floor(r), t = r - i;
  return values[i] * (1 - t) + values[i + 1] * t;
}

/* ---------- Sweep measurement ---------- */

/** Exponential sine sweep (Farina). Must match SweepGenerator.kt. */
export function makeSweep(sr, f1, f2, T) {
  const n = Math.round(sr * T), x = new Float32Array(n);
  const w1 = 2 * Math.PI * f1, R = Math.log(f2 / f1), K = w1 * T / R;
  const fin = Math.round(0.05 * sr), fout = Math.round(0.01 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let g = 1;
    if (i < fin) g = 0.5 - 0.5 * Math.cos(Math.PI * i / fin);
    else if (i > n - fout) g = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / fout);
    x[i] = g * Math.sin(K * (Math.exp(t * R / T) - 1));
  }
  return x;
}

/** Time (s) by which the k-th harmonic impulse precedes the linear one. */
export const harmonicOffset = (k, f1, f2, T) => T * Math.log(k) / Math.log(f2 / f1);

/** Regularized spectral division. Returns the circular impulse response and its main peak. */
export function deconvolve(rec, sweep) {
  const N = nextPow2(rec.length + sweep.length);
  const yr = new Float64Array(N), yi = new Float64Array(N);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  yr.set(rec); xr.set(sweep);
  fft(yr, yi); fft(xr, xi);
  let maxP = 0;
  for (let k = 0; k < N; k++) { const p = xr[k] * xr[k] + xi[k] * xi[k]; if (p > maxP) maxP = p; }
  const eps = maxP * 1e-4;
  for (let k = 0; k < N; k++) {
    const p = xr[k] * xr[k] + xi[k] * xi[k] + eps;
    const hr = (yr[k] * xr[k] + yi[k] * xi[k]) / p;
    const hi = (yi[k] * xr[k] - yr[k] * xi[k]) / p;
    yr[k] = hr; yi[k] = hi;
  }
  fft(yr, yi, true);
  let peak = 0, pv = 0;
  for (let i = 0; i < N / 2; i++) { const a = Math.abs(yr[i]); if (a > pv) { pv = a; peak = i; } }
  return { h: yr, peak };
}

/** Copies h[peak - pre, peak + post) with circular indexing (harmonics wrap to the end). */
export function extractIR(h, peak, pre, post) {
  const N = h.length, ir = new Float32Array(pre + post);
  for (let i = 0; i < ir.length; i++) ir[i] = h[(peak - pre + i + N) % N];
  return ir;
}

/** Power spectrum of a gated IR segment starting `preSec` before `start`. */
export function gatedPower(ir, start, sr, winSec, preSec = 0.002, minN = 65536) {
  const pre = Math.round(preSec * sr), len = Math.round(winSec * sr);
  const fadeIn = Math.max(1, Math.round(0.001 * sr)), fadeOut = Math.max(1, Math.round(len * 0.25));
  const N = nextPow2(Math.max(minN, len * 2));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len; i++) {
    const src = start - pre + i;
    if (src < 0 || src >= ir.length) continue;
    let g = 1;
    if (i < fadeIn) g = 0.5 - 0.5 * Math.cos(Math.PI * i / fadeIn);
    else if (i > len - fadeOut) g = 0.5 + 0.5 * Math.cos(Math.PI * (i - (len - fadeOut)) / fadeOut);
    re[i] = ir[src] * g;
  }
  fft(re, im);
  const P = new Float64Array(N / 2 + 1);
  for (let k = 0; k < P.length; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return { P, df: sr / N };
}

/** Fractional-octave smoothing of a power spectrum onto a grid, in dB (NaN above Nyquist). */
export function smoothToGrid(P, df, frac, grid = GRID) {
  const S = new Float64Array(P.length + 1);
  for (let k = 0; k < P.length; k++) S[k + 1] = S[k] + P[k];
  const r = 2 ** (1 / (2 * frac)), nyq = (P.length - 1) * df;
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i];
    if (f * r > nyq) { out[i] = NaN; continue; }
    const kl = Math.max(1, Math.floor(f / r / df));
    const kh = Math.max(kl, Math.min(P.length - 1, Math.ceil(f * r / df)));
    out[i] = db10((S[kh + 1] - S[kl]) / (kh - kl + 1));
  }
  return out;
}

/** Re-smooths a dB curve already on the grid (power average over ±1/(2·frac) octave). */
export function smoothCurve(curve, frac, grid = GRID) {
  const n = grid.length, step = Math.log2(grid[n - 1] / grid[0]) / (n - 1);
  const half = Math.max(0, Math.round(1 / (2 * frac) / step));
  const p = Float64Array.from(curve, v => Number.isFinite(v) ? 10 ** (v / 10) : NaN);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (Number.isFinite(p[j])) { s += p[j]; c++; }
    out[i] = c ? db10(s / c) : NaN;
  }
  return out;
}

export function maxIn(curve, lo, hi, grid = GRID) {
  let m = -Infinity;
  for (let i = 0; i < grid.length; i++) if (grid[i] >= lo && grid[i] <= hi && curve[i] > m) m = curve[i];
  return m;
}

/** Local maxima on the grid ranked by prominence, with -3 dB Q estimate. */
export function findPeaks(v, lo, hi, { minProm = 3, maxCount = 8, grid = GRID } = {}) {
  let a = 0, b = grid.length - 1;
  while (a < b && grid[a] < lo) a++;
  while (b > a && grid[b] > hi) b--;
  const peaks = [];
  for (let i = a + 1; i < b; i++) {
    if (!(v[i] > v[i - 1] && v[i] >= v[i + 1])) continue;
    let minL = v[i], j = i - 1;
    while (j >= a && v[j] <= v[i]) { minL = Math.min(minL, v[j]); j--; }
    let minR = v[i]; j = i + 1;
    while (j <= b && v[j] <= v[i]) { minR = Math.min(minR, v[j]); j++; }
    const prom = v[i] - Math.max(minL, minR);
    if (prom >= minProm) peaks.push({ f: grid[i], db: v[i], prom, q: estimateQ(v, i, grid) });
  }
  return peaks.sort((x, y) => y.prom - x.prom).slice(0, maxCount);
}

export function estimateQ(v, i, grid = GRID) {
  const target = v[i] - 3;
  const edge = step => {
    for (let j = i + step; j > 0 && j < v.length; j += step) {
      if (v[j] < target) {
        const t = (target - v[j]) / (v[j - step] - v[j]);
        return Math.exp(Math.log(grid[j]) + t * (Math.log(grid[j - step]) - Math.log(grid[j])));
      }
      if (v[j] > v[i]) return null;
    }
    return null;
  };
  const fl = edge(-1), fh = edge(1);
  return fl && fh ? grid[i] / (fh - fl) : null;
}

/* ---------- Impulse response views ---------- */

/** Energy-time curve (Hilbert envelope, dB re peak) of ir[from, to). */
export function etc(ir, from, to) {
  const len = to - from, N = nextPow2(len);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len; i++) re[i] = ir[from + i] || 0;
  fft(re, im);
  for (let k = 1; k < N / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = N / 2 + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
  fft(re, im, true);
  const out = new Float64Array(len);
  let m = 0;
  for (let i = 0; i < len; i++) { out[i] = re[i] * re[i] + im[i] * im[i]; if (out[i] > m) m = out[i]; }
  for (let i = 0; i < len; i++) out[i] = db10(out[i] / m);
  return out;
}

/** Cumulative spectral decay: gated spectra with the gate start moving along the decay. */
export function waterfall(ir, peak, sr, { t1 = 0.3, slices = 30, win = 0.3, frac = 12, grid = GRID } = {}) {
  const out = [];
  for (let s = 0; s < slices; s++) {
    const t = t1 * s / slices;
    const { P, df } = gatedPower(ir, peak + Math.round(t * sr), sr, win, s === 0 ? 0.002 : 0.0005, 16384);
    out.push({ t, curve: smoothToGrid(P, df, frac, grid) });
  }
  return out;
}

/* ---------- Room acoustics (ISO 3382) ---------- */

export const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/** Zero-phase band-pass (6th-order Butterworth magnitude) applied in the frequency domain. */
export function bandFilter(x, sr, fc, frac = 1, order = 3) {
  const N = nextPow2(x.length * 2), re = new Float64Array(N), im = new Float64Array(N);
  re.set(x);
  fft(re, im);
  const bw = 2 ** (1 / (2 * frac)) - 2 ** (-1 / (2 * frac));
  for (let k = 0; k <= N / 2; k++) {
    const f = Math.max(k, 1e-3) * sr / N;
    const g = 1 / Math.sqrt(1 + ((f / fc - fc / f) / bw) ** (2 * order));
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
  }
  fft(re, im, true);
  return re.subarray(0, x.length);
}

/** Least-squares line through (x, y); returns slope, intercept and correlation r. */
function regress(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}

/**
 * Decay parameters from an impulse response segment starting at its direct sound.
 * Noise floor from the last 10% is subtracted and the Schroeder integral truncated at the
 * point where the envelope meets the noise (simplified Lundeby).
 */
export function decayAnalysis(x, sr) {
  const n = x.length, e = new Float64Array(n);
  let maxE = 0;
  for (let i = 0; i < n; i++) { e[i] = x[i] * x[i]; if (e[i] > maxE) maxE = e[i]; }

  let noise = 0;
  const nStart = Math.floor(n * 0.9);
  for (let i = nStart; i < n; i++) noise += e[i];
  noise /= n - nStart;

  // 10 ms envelope blocks; truncate where the envelope reaches noise + 5 dB.
  const blk = Math.max(1, Math.round(0.01 * sr));
  let cut = n;
  for (let a = blk; a + blk <= n; a += blk) {
    let s = 0;
    for (let i = a; i < a + blk; i++) s += e[i];
    if (s / blk < noise * 3.16) { cut = a; break; }
  }
  const dynRange = db10(maxE / Math.max(noise, 1e-30));

  // Backward integration with noise subtraction, sampled every 1 ms.
  const cum = new Float64Array(cut + 1);
  for (let i = cut - 1; i >= 0; i--) cum[i] = cum[i + 1] + Math.max(0, e[i] - noise);
  const total = cum[0] || 1e-30, step = Math.max(1, Math.round(0.001 * sr));
  const ts = [], L = [];
  for (let i = 0; i < cut; i += step) { if (cum[i] <= 0) break; ts.push(i / sr); L.push(db10(cum[i] / total)); }

  const fit = (top, bottom, need) => {
    if (dynRange < need) return null;
    const xs = [], ys = [];
    for (let i = 0; i < L.length; i++) if (L[i] <= top && L[i] >= bottom) { xs.push(ts[i]); ys.push(L[i]); }
    if (!L.length || L[L.length - 1] > bottom) return null;
    const r = regress(xs, ys);
    return r && r.slope < 0 ? { ...r, t60: -60 / r.slope, top, bottom } : null;
  };

  // Clarity, definition and centre time on the noise-compensated energy.
  const E = t => { const k = Math.min(cut, Math.round(t * sr)); return total - cum[k]; };
  let tsNum = 0;
  for (let i = 0; i < cut; i++) tsNum += i / sr * Math.max(0, e[i] - noise);

  return {
    schroeder: { t: ts, L },
    edt: fit(0, -10, 20),
    t20: fit(-5, -25, 35),
    t30: fit(-5, -35, 45),
    c50: db10(E(0.05) / Math.max(total - E(0.05), 1e-30)),
    c80: db10(E(0.08) / Math.max(total - E(0.08), 1e-30)),
    d50: E(0.05) / total * 100,
    ts: tsNum / total,
    dynRange,
    cutTime: cut / sr,
  };
}

/** Broadband and octave-band decay analysis: one forward FFT, one inverse per band. */
export function roomAcoustics(ir, peak, sr, maxSec = 2.5) {
  const start = Math.max(0, peak - Math.round(0.001 * sr));
  const seg = ir.subarray(start, Math.min(ir.length, start + Math.round(maxSec * sr)));
  const N = nextPow2(seg.length + Math.round(0.25 * sr)), Re = new Float64Array(N), Im = new Float64Array(N);
  Re.set(seg);
  fft(Re, Im);
  const bw = 2 ** 0.5 - 2 ** -0.5, re = new Float64Array(N), im = new Float64Array(N);
  const bands = OCTAVES.filter(fc => fc < sr * 0.35).map(fc => {
    for (let k = 0; k <= N / 2; k++) {
      const f = Math.max(k, 1e-3) * sr / N, g = 1 / Math.sqrt(1 + ((f / fc - fc / f) / bw) ** 6);
      re[k] = Re[k] * g; im[k] = Im[k] * g;
      if (k > 0 && k < N / 2) { re[N - k] = Re[N - k] * g; im[N - k] = Im[N - k] * g; }
    }
    fft(re, im, true);
    return { fc, ...decayAnalysis(re.slice(0, seg.length), sr) };
  });
  return { broadband: decayAnalysis(seg, sr), bands };
}

/** Reverberation time to report: T30, else T20, else EDT. */
export const bestRT = d => d?.t30?.t60 ?? d?.t20?.t60 ?? d?.edt?.t60 ?? NaN;

/* ---------- Harmonic distortion (ESS) ---------- */

/**
 * Harmonic levels relative to the fundamental, read at the fundamental frequency.
 * The k-th harmonic IR sits harmonicOffset(k) before the linear one; its spectrum at k·f
 * divided by the linear spectrum at f is the harmonic amplitude ratio (verified in tests).
 */
export function distortion(ir, peak, sr, { f1, f2, dur }, { kMax = 5, frac = 6, grid = GRID } = {}) {
  const spacing = harmonicOffset(kMax, f1, f2, dur) - harmonicOffset(kMax - 1, f1, f2, dur);
  const win = Math.min(0.1, spacing * 0.8);
  const spec = k => {
    const pos = peak - Math.round(harmonicOffset(k, f1, f2, dur) * sr);
    const { P, df } = gatedPower(ir, pos, sr, win, 0.001, 16384);
    return smoothToGrid(P, df, frac, grid);
  };
  const fund = spec(1), harmonics = [];
  const thdP = new Float64Array(grid.length);
  for (let k = 2; k <= kMax; k++) {
    const hk = spec(k), rel = new Float64Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      const f = grid[i];
      rel[i] = f * k > f2 || f < f1 ? NaN : interpLog(grid, hk, f * k) - fund[i];
      if (Number.isFinite(rel[i])) thdP[i] += 10 ** (rel[i] / 10);
    }
    harmonics.push({ k, rel });
  }
  const thd = Float64Array.from(thdP, (p, i) => (grid[i] * 2 > f2 || grid[i] < f1 ? NaN : db10(p)));
  return { fundamental: fund, harmonics, thd, window: win };
}

/* ---------- Spectrum analysis (RTA / SPL) ---------- */

export const THIRD_OCT = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

/** Exact base-2 centre for a nominal third-octave frequency. */
export const exactCenter = (nominal, frac = 3) => 1000 * 2 ** (Math.round(frac * Math.log2(nominal / 1000)) / frac);

/** A/C/Z frequency weighting in dB (IEC 61672). */
export function weighting(f, type) {
  if (type === "A") {
    const f2 = f * f;
    const ra = 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
    return db20(ra) + 2.0;
  }
  if (type === "C") {
    const f2 = f * f;
    return db20(12194 ** 2 * f2 / ((f2 + 20.6 ** 2) * (f2 + 12194 ** 2))) + 0.06;
  }
  return 0;
}

const hannCache = new Map();
export function hann(N) {
  if (!hannCache.has(N)) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    hannCache.set(N, w);
  }
  return hannCache.get(N);
}

/**
 * Hann-windowed one-sided power spectrum scaled so that summing bins gives the mean square
 * of the signal (times two, so a full-scale sine reads 0 dBFS). `padTo` zero-pads for resolution.
 */
export function powerSpectrum(frame, sr, padTo = frame.length) {
  const n = frame.length, N = nextPow2(padTo), w = hann(n);
  const re = new Float64Array(N), im = new Float64Array(N);
  let sw = 0;
  for (let i = 0; i < n; i++) { re[i] = frame[i] * w[i]; sw += w[i] * w[i]; }
  fft(re, im);
  const P = new Float64Array(N / 2 + 1), scale = 4 / (n * sw) * (n / N);
  for (let k = 0; k < P.length; k++) P[k] = (re[k] * re[k] + im[k] * im[k]) * scale;
  return { P, df: sr / N };
}

/** Band levels (dBFS) from a power spectrum; df here is in Hz. */
export function bandLevels(P, df, centers = THIRD_OCT, frac = 3, weight = "Z") {
  const half = 2 ** (1 / (2 * frac));
  return centers.map(nom => {
    const fc = exactCenter(nom, frac), lo = fc / half, hi = fc * half;
    let s = 0;
    for (let k = Math.max(1, Math.ceil(lo / df)); k <= Math.min(P.length - 1, Math.floor(hi / df)); k++) {
      s += P[k] * 10 ** (weighting(k * df, weight) / 10);
    }
    return { fc: nom, lo, hi, db: db10(s) };
  });
}

/** Weighted overall level (dBFS) from a power spectrum. */
export function overallLevel(P, df, weight = "Z", lo = 10, hi = 22000) {
  let s = 0;
  for (let k = Math.max(1, Math.ceil(lo / df)); k <= Math.min(P.length - 1, Math.floor(hi / df)); k++) {
    s += weight === "Z" ? P[k] : P[k] * 10 ** (weighting(k * df, weight) / 10);
  }
  return db10(s);
}

/** Strongest bin in [lo, hi] with parabolic interpolation on log magnitude. */
export function dominant(P, df, lo, hi) {
  let best = -1, bv = 0;
  for (let k = Math.max(2, Math.ceil(lo / df)); k < Math.min(P.length - 2, Math.floor(hi / df)); k++) {
    if (P[k] > bv && P[k] >= P[k - 1] && P[k] >= P[k + 1]) { bv = P[k]; best = k; }
  }
  if (best < 0) return null;
  const a = Math.log(P[best - 1] + 1e-30), b = Math.log(bv), g = Math.log(P[best + 1] + 1e-30);
  const d = a - 2 * b + g ? 0.5 * (a - g) / (a - 2 * b + g) : 0;
  return { f: (best + d) * df, db: db10(bv) };
}

/* ---------- Tapped object (glass) analysis ---------- */

/** Single-bin DFT magnitude (Goertzel) over x[a, b), normalized by length. */
export function goertzel(x, a, b, f, sr) {
  const w = 2 * Math.PI * f / sr, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a);
}

/** Decay of a single frequency: envelope (dB) in 20 ms blocks and fitted T60/Q. */
export function toneDecay(x, start, end, f, sr, rangeDb = 40) {
  const blk = Math.round(0.02 * sr), env = [];
  for (let a = start; a + blk <= end; a += blk) env.push(db20(goertzel(x, a, a + blk, f, sr)));
  const xs = [], ys = [];
  for (let i = 0; i < env.length && env[i] > env[0] - rangeDb; i++) { xs.push(i * blk / sr); ys.push(env[i]); }
  const r = regress(xs, ys);
  const slope = r && r.slope < 0 ? r.slope : NaN;
  const tau = 20 * Math.LOG10E / -slope;
  return { env, blockSec: blk / sr, t60: 60 / -slope, q: Math.PI * f * tau };
}

/** Finds the dominant ringing mode of a tapped object, its partials and decay. */
export function analyzeTap(rec, sr, { lo = 200, hi = 10000 } = {}) {
  let pk = 0, pv = 0;
  for (let i = 0; i < rec.length; i++) { const a = Math.abs(rec[i]); if (a > pv) { pv = a; pk = i; } }
  if (pv < 0.01) throw new Error("Nenhuma batida detectada. Bata mais forte ou aproxime a taça do microfone.");

  const start = pk + Math.round(0.01 * sr);
  const len = Math.min(rec.length - start, Math.round(2.5 * sr));
  if (len < 0.3 * sr) throw new Error("A batida ficou no fim da gravação. Bata logo depois de tocar em Ouvir batida.");

  const N = 1 << 19, re = new Float64Array(N), im = new Float64Array(N), taper = Math.round(len * 0.2);
  for (let i = 0; i < len; i++) {
    const g = i > len - taper ? 0.5 + 0.5 * Math.cos(Math.PI * (i - (len - taper)) / taper) : 1;
    re[i] = rec[start + i] * g;
  }
  fft(re, im);
  const df = sr / N, kLo = Math.ceil(lo / df), kHi = Math.min(N / 2 - 1, Math.floor(hi / df));
  const mag = k => Math.hypot(re[k], im[k]);

  const cands = [];
  for (let k = kLo + 1; k < kHi; k++) {
    const m = mag(k);
    if (m > mag(k - 1) && m >= mag(k + 1)) cands.push({ k, m });
  }
  cands.sort((a, b) => b.m - a.m);
  const peaks = [];
  for (const c of cands) {
    if (c.m < cands[0].m * 0.03 || peaks.length >= 6) break;
    const a = Math.log(mag(c.k - 1)), b = Math.log(c.m), g = Math.log(mag(c.k + 1));
    const f = (c.k + 0.5 * (a - g) / (a - 2 * b + g)) * df;
    if (peaks.every(p => Math.abs(p.f - f) / p.f > 0.03)) peaks.push({ f, db: db20(c.m / cands[0].m) });
  }

  // Display spectrum on a grid limited to the analysis band.
  const grid = logspace(lo, hi, 600), P = new Float64Array(N / 2 + 1);
  for (let k = 0; k < P.length; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  const spectrum = smoothToGrid(P, df, 96, grid);
  const top = Math.max(...spectrum.filter(Number.isFinite));
  for (let i = 0; i < spectrum.length; i++) spectrum[i] -= top;

  const f0 = peaks[0].f, decay = toneDecay(rec, start, start + len, f0, sr);
  return { f0, peaks, q: decay.q, t60: decay.t60, level: db20(pv), grid, spectrum };
}

/* ---------- Equalization ---------- */

/** RBJ peaking biquad magnitude (dB) at f. */
export function peakingDb(f, fc, gainDb, q, sr = 48000) {
  const A = 10 ** (gainDb / 40), w0 = 2 * Math.PI * fc / sr, alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * cw, b2 = 1 - alpha * A, a0 = 1 + alpha / A, a1 = -2 * cw, a2 = 1 - alpha / A;
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Target curves for auto-EQ, relative to a reference level. */
export function targetCurve(type, ref, grid = GRID) {
  return Float64Array.from(grid, f => ref + (type === "house" ? 6 / (1 + (f / 100) ** 2) : 0));
}

/**
 * Greedy cut-only EQ: repeatedly places a peaking cut on the largest excess over the target.
 * Cuts only, because boosting room nulls wastes amplifier headroom without filling them.
 */
export function autoEq(curve, target, { lo = 20, hi = 300, maxFilters = 8, maxCut = 15, minQ = 0.7, maxQ = 15, tol = 1.5, sr = 48000, grid = GRID } = {}) {
  const corrected = Float64Array.from(curve), filters = [];
  for (let n = 0; n < maxFilters; n++) {
    let bi = -1, bd = tol;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < lo || grid[i] > hi || !Number.isFinite(corrected[i])) continue;
      const d = corrected[i] - target[i];
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi < 0) break;
    const half = bd / 2, edge = step => {
      let j = bi;
      while (j + step >= 0 && j + step < grid.length && corrected[j + step] - target[j + step] > half) j += step;
      return grid[j];
    };
    const fl = edge(-1), fh = edge(1), fc = grid[bi];
    const q = Math.min(maxQ, Math.max(minQ, fc / Math.max(fh - fl, fc / maxQ)));
    const gain = -Math.min(bd, maxCut);
    for (let i = 0; i < grid.length; i++) corrected[i] += peakingDb(grid[i], fc, gain, q, sr);
    filters.push({ fc, gain, q });
  }
  filters.sort((a, b) => a.fc - b.fc);
  return { filters, corrected };
}

/** Equalizer APO / REW-style filter text. */
export function eqText(filters) {
  return filters.map((f, i) =>
    `Filter ${i + 1}: ON PK Fc ${f.fc.toFixed(1)} Hz Gain ${f.gain.toFixed(1)} dB Q ${f.q.toFixed(2)}`).join("\n");
}

/* ---------- Room modes ---------- */

export const speedOfSound = tempC => 331.3 + 0.606 * tempC;

export function roomModes(L, W, H, fmax, c = 343) {
  const modes = [];
  const pm = Math.floor(2 * L * fmax / c), qm = Math.floor(2 * W * fmax / c), rm = Math.floor(2 * H * fmax / c);
  for (let p = 0; p <= pm; p++) for (let q = 0; q <= qm; q++) for (let r = 0; r <= rm; r++) {
    if (!p && !q && !r) continue;
    const f = c / 2 * Math.sqrt((p / L) ** 2 + (q / W) ** 2 + (r / H) ** 2);
    if (f > fmax) continue;
    const nz = (p > 0) + (q > 0) + (r > 0);
    modes.push({ f, n: [p, q, r], type: nz === 1 ? "axial" : nz === 2 ? "tangential" : "oblique" });
  }
  return modes.sort((a, b) => a.f - b.f);
}

/** Axial modes only (cheap): n·c/2D for each dimension. */
export function axialModes(L, W, H, fmax, c = 343) {
  const out = [];
  [L, W, H].forEach((D, axis) => {
    for (let n = 1; n * c / (2 * D) <= fmax; n++) out.push({ f: n * c / (2 * D), n: [0, 0, 0].map((_, i) => (i === axis ? n : 0)), type: "axial" });
  });
  return out.sort((a, b) => a.f - b.f);
}

export const schroederFreq = (rt60, volume) => 2000 * Math.sqrt(rt60 / volume);

/** Bonello: mode count per third-octave band should not decrease; flags close axial pairs (< 5 Hz). */
export function bonello(modes, fmax) {
  const out = [];
  let prev = 0;
  for (const nom of THIRD_OCT) {
    const fc = exactCenter(nom), lo = fc / 2 ** (1 / 6), hi = fc * 2 ** (1 / 6);
    if (lo > fmax) break;
    const inBand = modes.filter(m => m.f >= lo && m.f < hi);
    const axial = inBand.filter(m => m.type === "axial").map(m => m.f);
    const clash = axial.some((f, i) => axial.some((g, j) => j > i && Math.abs(f - g) < 5));
    out.push({ fc: nom, count: inBand.length, ok: inBand.length >= prev, clash });
    if (inBand.length) prev = inBand.length;
  }
  return out;
}

/* ---------- Misc ---------- */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Nearest equal-tempered note and deviation in cents. */
export function noteOf(f, a4 = 440) {
  if (!(f > 0)) return null;
  const midi = 69 + 12 * Math.log2(f / a4), m = Math.round(midi);
  return { name: NOTE_NAMES[((m % 12) + 12) % 12], octave: Math.floor(m / 12) - 1, cents: (midi - m) * 100, midi: m, freq: a4 * 2 ** ((m - 69) / 12) };
}

/** Parses REW-style calibration text: "freq dB [phase]" lines, optional "Sens Factor" header. */
export function parseCal(text) {
  const points = [];
  let sens = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sm = line.match(/Sens\s*Factor\s*=\s*(-?[\d.]+)/i);
    if (sm) sens = parseFloat(sm[1]);
    if (!/^[-+]?\d/.test(line)) continue;
    const [f, g] = line.split(/[\s,;]+/).map(Number);
    if (Number.isFinite(f) && Number.isFinite(g) && f > 0 && (!points.length || f > points[points.length - 1][0])) points.push([f, g]);
  }
  if (points.length < 2) throw new Error("Arquivo sem pares frequência/ganho válidos.");
  return { points, sens };
}

/** Calibration gain (dB) at f, log-interpolated and clamped at the ends. */
export function calAt(cal, f) {
  const p = cal.points;
  if (f <= p[0][0]) return p[0][1];
  if (f >= p[p.length - 1][0]) return p[p.length - 1][1];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= f) lo = m; else hi = m; }
  const t = Math.log(f / p[lo][0]) / Math.log(p[hi][0] / p[lo][0]);
  return p[lo][1] + t * (p[hi][1] - p[lo][1]);
}

/** Power average of dB curves (spatial averaging). */
export function averageCurves(curves) {
  return Float64Array.from(curves[0], (_, i) => {
    let s = 0, c = 0;
    for (const cv of curves) if (Number.isFinite(cv[i])) { s += 10 ** (cv[i] / 10); c++; }
    return c ? db10(s / c) : NaN;
  });
}

/** 32-bit float mono WAV. */
export function wavFloat32(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 4, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
  str(36, "data"); v.setUint32(40, samples.length * 4, true);
  for (let i = 0; i < samples.length; i++) v.setFloat32(44 + i * 4, samples[i], true);
  return buf;
}

/** Pink noise (Paul Kellet's refined filter), roughly unit peak. Matches SignalGenerator.kt. */
export function pinkNoise(n, rand = Math.random) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}
