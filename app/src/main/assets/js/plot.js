// Canvas charts: XY plot (log/linear), scrolling spectrogram and 3D waterfall.
import { GRID, interpLog } from "./dsp.js";
import { fmt } from "./ui.js";

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = c => (c && c.startsWith("--") ? cssVar(c) : c);
const MONO = () => `11px ${cssVar("--f-mono") || "monospace"}`;

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const hzLabel = f => (f >= 1000 ? `${f / 1000}k` : String(f));

function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/* Keeps every chart in sync with theme changes. */
const registry = new Set();
const redrawAll = () => registry.forEach(p => p.draw());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawAll);
new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/**
 * XY chart. Series kinds:
 *  line:  { y, x? (default GRID), color, width, fill, dash, label }
 *  bars:  { bars: [{ lo, hi, v }], color, label }
 *  stems: { stems: [{ x, h (0–1), color }] }
 */
export class Plot {
  constructor(canvas, opts = {}) {
    this.c = canvas;
    this.o = {
      xType: "log", x: [20, 20000], y: [-50, 5], yStep: null, pad: { l: 42, r: 10, t: 12, b: 24 },
      fmtX: v => (v >= 1000 ? `${fmt(v / 1000, 2)} kHz` : `${fmt(v, v < 100 ? 1 : 0)} Hz`),
      fmtY: v => `${fmt(v, 1)} dB`, xTick: hzLabel, yTick: v => fmt(v, 0), onTap: null,
      ...opts,
    };
    this.series = []; this.markers = []; this.hoverX = null;
    canvas.addEventListener("pointerdown", e => { this._hover(e); this.o.onTap?.(this.hoverX); });
    canvas.addEventListener("pointermove", e => { if (e.pointerType === "mouse" || e.buttons) this._hover(e); });
    canvas.addEventListener("pointerleave", () => { this.hoverX = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
    registry.add(this);
  }

  set({ series, markers, x, y, ...rest } = {}) {
    if (series) this.series = series;
    if (markers) this.markers = markers;
    if (x) this.o.x = x;
    if (y) this.o.y = y;
    Object.assign(this.o, rest);
    this.draw();
  }

  X(v) {
    const { pad } = this.o, [a, b] = this.o.x, pw = this.w - pad.l - pad.r;
    return pad.l + (this.o.xType === "log" ? Math.log(v / a) / Math.log(b / a) : (v - a) / (b - a)) * pw;
  }

  invX(px) {
    const { pad } = this.o, [a, b] = this.o.x, t = (px - pad.l) / (this.w - pad.l - pad.r);
    return this.o.xType === "log" ? a * (b / a) ** t : a + t * (b - a);
  }

  Y(v) {
    const { pad } = this.o, [lo, hi] = this.o.y;
    return pad.t + (hi - v) / (hi - lo) * (this.h - pad.t - pad.b);
  }

  _hover(e) {
    const x = e.clientX - this.c.getBoundingClientRect().left, v = this.invX(x);
    this.hoverX = v >= this.o.x[0] && v <= this.o.x[1] ? v : null;
    this.draw();
  }

  valueAt(s, xv) {
    if (s.bars) return s.bars.find(b => xv >= b.lo && xv < b.hi)?.v;
    if (!s.y) return undefined;
    const xs = s.x || GRID;
    if (xs === GRID) return interpLog(GRID, s.y, xv);
    let lo = 0, hi = xs.length - 1;
    if (xv <= xs[0] || xv >= xs[hi]) return undefined;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= xv) lo = m; else hi = m; }
    const t = (xv - xs[lo]) / (xs[hi] - xs[lo]);
    return s.y[lo] * (1 - t) + s.y[hi] * t;
  }

  draw() {
    const { g, w, h } = setupCanvas(this.c);
    this.w = w; this.h = h;
    if (!w || !h) return;
    const { pad } = this.o, [xa, xb] = this.o.x, [ya, yb] = this.o.y;
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const C = { fg: color("--fg"), muted: color("--muted"), line: color("--line"), panel: color("--panel") };
    g.font = MONO(); g.lineWidth = 1;

    // Grid: x
    if (this.o.xType === "log") {
      for (let dec = 1; dec <= 100000; dec *= 10) for (let m = 1; m <= 9; m++) {
        const f = dec * m;
        if (f < xa || f > xb) continue;
        const major = m === 1 || m === 2 || m === 5;
        g.strokeStyle = C.line; g.globalAlpha = major ? 1 : 0.45;
        g.beginPath(); g.moveTo(this.X(f), pad.t); g.lineTo(this.X(f), pad.t + ph); g.stroke();
        if (major && pw > 220) { g.globalAlpha = 1; g.fillStyle = C.muted; g.textAlign = "center"; g.fillText(this.o.xTick(f), this.X(f), h - 7); }
      }
    } else {
      const step = niceStep(xb - xa, Math.max(3, Math.floor(pw / 70)));
      for (let v = Math.ceil(xa / step) * step; v <= xb + 1e-9; v += step) {
        g.strokeStyle = C.line; g.beginPath(); g.moveTo(this.X(v), pad.t); g.lineTo(this.X(v), pad.t + ph); g.stroke();
        g.fillStyle = C.muted; g.textAlign = "center"; g.fillText(this.o.xTick(+v.toFixed(6)), this.X(v), h - 7);
      }
    }
    g.globalAlpha = 1;
    // Grid: y
    const ys = this.o.yStep || niceStep(yb - ya, Math.max(3, Math.floor(ph / 45)));
    for (let v = Math.ceil(ya / ys) * ys; v <= yb + 1e-9; v += ys) {
      g.strokeStyle = C.line; g.beginPath(); g.moveTo(pad.l, this.Y(v)); g.lineTo(pad.l + pw, this.Y(v)); g.stroke();
      g.fillStyle = C.muted; g.textAlign = "right"; g.fillText(this.o.yTick(+v.toFixed(6)), pad.l - 6, this.Y(v) + 4);
    }

    g.save();
    g.beginPath(); g.rect(pad.l, pad.t, pw, ph); g.clip();

    for (const s of this.series) {
      if (s.stems) this._stems(g, s, ph);
      else if (s.bars) this._bars(g, s);
      else if (s.y) this._line(g, s, pw, ph);
    }

    for (const m of this.markers) {
      if (m.x < xa || m.x > xb) continue;
      const x = this.X(m.x);
      g.strokeStyle = color(m.color || "--mode"); g.fillStyle = g.strokeStyle;
      if (m.y === undefined) {
        g.setLineDash([3, 3]); g.globalAlpha = 0.7;
        g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
        if (m.label) { g.textAlign = "center"; g.fillText(m.label, x, pad.t + ph - 4); }
      } else {
        const y = this.Y(m.y);
        g.fillStyle = C.panel; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, m.big ? 5 : 3.5, 0, Math.PI * 2); g.fill(); g.strokeStyle = C.fg; g.stroke();
        if (m.label) { g.fillStyle = C.fg; g.textAlign = "center"; g.fillText(m.label, x, Math.max(pad.t + 10, y - 9)); }
        g.lineWidth = 1;
      }
    }

    if (this.hoverX != null) this._readout(g, C, pw, ph);
    g.restore();
  }

  _line(g, s, pw) {
    const xs = s.x || GRID, ys = s.y, n = ys.length, [xa, xb] = this.o.x;
    g.strokeStyle = color(s.color || "--accent"); g.lineWidth = s.width || 2; g.setLineDash(s.dash || []);
    g.beginPath();
    let started = false, firstX = 0, lastX = 0;
    if (n > pw * 3) {
      // Min/max per pixel column keeps dense signals (impulse responses) faithful.
      let col = -1, mn = 0, mx = 0;
      const flush = () => {
        if (col < 0) return;
        if (!started) { g.moveTo(col, this.Y(mx)); firstX = col; started = true; } else g.lineTo(col, this.Y(mx));
        g.lineTo(col, this.Y(mn)); lastX = col;
      };
      for (let i = 0; i < n; i++) {
        if (xs[i] < xa || xs[i] > xb || !Number.isFinite(ys[i])) continue;
        const px = Math.round(this.X(xs[i]));
        if (px !== col) { flush(); col = px; mn = mx = ys[i]; } else { mn = Math.min(mn, ys[i]); mx = Math.max(mx, ys[i]); }
      }
      flush();
    } else {
      for (let i = 0; i < n; i++) {
        if (xs[i] < xa * 0.98 || xs[i] > xb * 1.02 || !Number.isFinite(ys[i])) continue;
        const x = this.X(xs[i]), y = this.Y(Math.max(this.o.y[0] - 10, Math.min(this.o.y[1] + 10, ys[i])));
        if (!started) { g.moveTo(x, y); firstX = x; started = true; } else g.lineTo(x, y);
        lastX = x;
      }
    }
    g.stroke(); g.setLineDash([]);
    if (s.fill && started) {
      g.lineTo(lastX, this.Y(this.o.y[0])); g.lineTo(firstX, this.Y(this.o.y[0])); g.closePath();
      g.globalAlpha = 0.12; g.fillStyle = color(s.color || "--accent"); g.fill(); g.globalAlpha = 1;
    }
    g.lineWidth = 1;
  }

  _bars(g, s) {
    const base = this.Y(Math.max(this.o.y[0], s.base ?? this.o.y[0]));
    for (const b of s.bars) {
      if (!Number.isFinite(b.v)) continue;
      const x0 = this.X(b.lo) + 1, x1 = this.X(b.hi) - 1, y = this.Y(Math.min(this.o.y[1], b.v));
      g.fillStyle = color(b.color || s.color || "--accent"); g.globalAlpha = s.alpha ?? 0.85;
      g.fillRect(x0, Math.min(y, base), Math.max(1, x1 - x0), Math.abs(base - y));
      if (Number.isFinite(b.hold)) {
        g.globalAlpha = 1; g.fillStyle = color("--fg");
        g.fillRect(x0, this.Y(b.hold) - 1, Math.max(1, x1 - x0), 2);
      }
    }
    g.globalAlpha = 1;
  }

  _stems(g, s, ph) {
    const bottom = this.o.pad.t + ph;
    for (const st of s.stems) {
      if (st.x < this.o.x[0] || st.x > this.o.x[1]) continue;
      const x = this.X(st.x);
      g.strokeStyle = color(st.color || "--mode"); g.lineWidth = st.width || 2; g.globalAlpha = st.alpha ?? 0.8;
      g.beginPath(); g.moveTo(x, bottom); g.lineTo(x, bottom - st.h * ph); g.stroke();
    }
    g.globalAlpha = 1; g.lineWidth = 1;
  }

  _readout(g, C, pw) {
    const xv = this.hoverX, x = this.X(xv), { pad } = this.o;
    g.strokeStyle = C.muted; g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, this.h - pad.b); g.stroke();
    const rows = [[this.o.fmtX(xv), C.fg]];
    for (const s of this.series) {
      if (s.noReadout) continue;
      const v = this.valueAt(s, xv);
      if (!Number.isFinite(v)) continue;
      rows.push([(s.label ? s.label + " " : "") + this.o.fmtY(v), color(s.color || "--accent")]);
      if (s.y && !s.bars) { g.fillStyle = color(s.color || "--accent"); g.beginPath(); g.arc(x, this.Y(v), 3.5, 0, Math.PI * 2); g.fill(); }
    }
    const lw = Math.max(...rows.map(r => g.measureText(r[0]).width)) + 16, lh = rows.length * 15 + 8;
    const bx = Math.min(Math.max(pad.l + 2, x + 8), pad.l + pw - lw - 2);
    const bxx = x + 8 + lw > pad.l + pw ? Math.max(pad.l + 2, x - 8 - lw) : bx;
    g.globalAlpha = 0.94; g.fillStyle = C.panel; g.fillRect(bxx, pad.t + 2, lw, lh);
    g.globalAlpha = 1; g.strokeStyle = C.line; g.strokeRect(bxx, pad.t + 2, lw, lh);
    g.textAlign = "left";
    rows.forEach(([t, c], i) => { g.fillStyle = c; g.fillText(t, bxx + 8, pad.t + 17 + i * 15); });
  }
}

/* ---------- Spectrogram ---------- */

const MAGMA = [[0, [8, 8, 30]], [0.25, [59, 28, 113]], [0.5, [140, 41, 129]], [0.7, [222, 73, 104]], [0.85, [254, 159, 109]], [1, [252, 253, 191]]];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255, j = MAGMA.findIndex(([p]) => p >= t), [p1, c1] = MAGMA[Math.max(1, j)], [p0, c0] = MAGMA[Math.max(0, j - 1)];
    const u = p1 > p0 ? (t - p0) / (p1 - p0) : 0;
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * u;
  }
  return lut;
})();

/** Scrolling log-frequency spectrogram; newest column at the right edge. */
export class Spectrogram {
  constructor(canvas, { fLo = 20, fHi = 20000, range = [-110, -30] } = {}) {
    this.c = canvas; this.fLo = fLo; this.fHi = fHi; this.range = range;
    this.axis = 40;
    new ResizeObserver(() => this.reset()).observe(canvas);
  }

  reset() {
    const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.round(this.c.clientWidth * dpr);
    this.c.height = Math.round(this.c.clientHeight * dpr);
    const g = this.c.getContext("2d");
    g.fillStyle = "rgb(8,8,30)"; g.fillRect(0, 0, this.c.width, this.c.height);
    this._axis();
  }

  _axis() {
    const g = this.c.getContext("2d"), dpr = window.devicePixelRatio || 1, H = this.c.height, ax = this.axis * dpr;
    g.fillStyle = color("--panel"); g.fillRect(0, 0, ax, H);
    g.fillStyle = color("--muted"); g.font = `${11 * dpr}px ${cssVar("--f-mono") || "monospace"}`; g.textAlign = "right";
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (f < this.fLo || f > this.fHi) continue;
      const y = H * (1 - Math.log(f / this.fLo) / Math.log(this.fHi / this.fLo));
      g.fillText(hzLabel(f), ax - 4 * dpr, y + 4 * dpr);
    }
  }

  push(P, df) {
    const g = this.c.getContext("2d"), W = this.c.width, H = this.c.height, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    const ax = Math.round(this.axis * dpr), col = Math.max(1, Math.round(2 * dpr));
    g.drawImage(this.c, ax + col, 0, W - ax - col, H, ax, 0, W - ax - col, H);
    const img = g.createImageData(col, H), [lo, hi] = this.range, ratio = Math.log(this.fHi / this.fLo);
    for (let y = 0; y < H; y++) {
      const f0 = this.fLo * Math.exp(ratio * (1 - (y + 1) / H)), f1 = this.fLo * Math.exp(ratio * (1 - y / H));
      let k0 = Math.max(1, Math.floor(f0 / df)), k1 = Math.max(k0, Math.min(P.length - 1, Math.ceil(f1 / df))), m = 0;
      for (let k = k0; k <= k1; k++) if (P[k] > m) m = P[k];
      const db = 10 * Math.log10(m + 1e-30), t = Math.max(0, Math.min(255, Math.round((db - lo) / (hi - lo) * 255)));
      for (let x = 0; x < col; x++) {
        const o = (y * col + x) * 4;
        img.data[o] = LUT[t * 3]; img.data[o + 1] = LUT[t * 3 + 1]; img.data[o + 2] = LUT[t * 3 + 2]; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, W - col, 0);
  }
}

/* ---------- Waterfall (cumulative spectral decay) ---------- */

/** slices: [{ t, curve }] on GRID, front slice first. */
export function drawWaterfall(canvas, slices, { fLo, fHi, range = [-40, 0], grid = GRID }) {
  const { g, w, h } = setupCanvas(canvas);
  if (!w || !h || !slices.length) return;
  const C = { fg: color("--fg"), muted: color("--muted"), line: color("--line"), panel: color("--panel"), a: color("--accent"), b: color("--mode") };
  const pad = { l: 36, r: 12, t: 10, b: 24 }, depthX = (w - pad.l - pad.r) * 0.22, depthY = (h - pad.t - pad.b) * 0.45;
  const fw = w - pad.l - pad.r - depthX, fh = h - pad.t - pad.b - depthY;
  const X = f => pad.l + Math.log(f / fLo) / Math.log(fHi / fLo) * fw;
  const Y = db => pad.t + depthY + (range[1] - Math.max(range[0], Math.min(range[1], db))) / (range[1] - range[0]) * fh;
  g.font = MONO(); g.lineWidth = 1;

  const n = slices.length, idx = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] >= fLo && grid[i] <= fHi) idx.push(i);
  const mix = (t) => {
    const p = s => [1, 3, 5].map(o => parseInt(s.slice(o, o + 2), 16));
    try { const a = p(C.a), b = p(C.b); return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(",")})`; } catch { return C.a; }
  };

  for (let s = n - 1; s >= 0; s--) {
    const ox = depthX * s / n, oy = -depthY * s / n, cv = slices[s].curve;
    g.beginPath();
    g.moveTo(X(fLo) + ox, Y(range[0]) + oy);
    for (const i of idx) g.lineTo(X(grid[i]) + ox, (Number.isFinite(cv[i]) ? Y(cv[i]) : Y(range[0])) + oy);
    g.lineTo(X(fHi) + ox, Y(range[0]) + oy);
    g.closePath();
    g.fillStyle = C.panel; g.globalAlpha = 0.92; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = mix(s / Math.max(1, n - 1)); g.lineWidth = s === 0 ? 2 : 1.2; g.stroke();
  }

  // Front axes
  g.lineWidth = 1; g.strokeStyle = C.line;
  g.beginPath(); g.moveTo(pad.l, Y(range[0])); g.lineTo(pad.l + fw, Y(range[0])); g.stroke();
  g.fillStyle = C.muted; g.textAlign = "center";
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) if (f >= fLo && f <= fHi) g.fillText(hzLabel(f), X(f), h - 7);
  g.textAlign = "right";
  for (let db = range[1]; db >= range[0]; db -= 10) g.fillText(String(db), pad.l - 6, Y(db) + 4);
  g.textAlign = "left";
  const last = slices[n - 1].t * 1000;
  g.fillText(`${fmt(last, 0)} ms`, pad.l + fw + depthX - 30, pad.t + 10);
  g.fillText("0 ms", pad.l + fw + 4, Y(range[0]) - 4);
}
