// Synthetic example measurement so every view opens in a realistic working state.
import { harmonicOffset } from "./dsp.js";

/** Small living room: modes at 41/56/82/112/139 Hz, RT60 ≈ 0.45 s, 2nd/3rd harmonic at −40/−48 dB. */
export function exampleMeasurement() {
  const sr = 48000, sweep = { f1: 30, f2: 16000, dur: 6 };
  const pre = Math.round((harmonicOffset(5, sweep.f1, sweep.f2, sweep.dur) + 0.05) * sr), post = Math.round(2.5 * sr);
  const ir = new Float32Array(pre + post);
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };

  // Direct sound, a few early reflections, diffuse tail.
  ir[pre] = 1;
  for (const [ms, a] of [[2.9, 0.45], [5.6, -0.3], [8.4, 0.25], [11.7, 0.2], [17, -0.15]]) ir[pre + Math.round(ms * sr / 1000)] += a;
  const rt = 0.45;
  for (let i = Math.round(0.004 * sr); i < post; i++) ir[pre + i] += 0.035 * rand() * 10 ** (-3 * (i / sr) / rt) + 2e-5 * rand();

  // Room modes as damped sinusoids.
  for (const [f, q, a] of [[41, 9, 0.05], [56, 11, 0.035], [82, 10, 0.03], [112, 12, 0.02], [139, 14, 0.016]]) {
    const tau = q / (Math.PI * f);
    for (let i = 0; i < post; i++) ir[pre + i] += a * Math.exp(-i / sr / tau) * Math.sin(2 * Math.PI * f * i / sr);
  }

  // Phone-speaker-like low cut: one-pole high-pass at 250 Hz applied forward.
  const k = Math.exp(-2 * Math.PI * 250 / sr);
  let xp = 0, yp = 0;
  for (let i = pre; i < ir.length; i++) { const x = ir[i]; yp = k * (yp + x - xp); xp = x; ir[i] = 0.35 * x + 0.65 * yp; }

  // Harmonic distortion impulses ahead of the linear response.
  ir[pre - Math.round(harmonicOffset(2, sweep.f1, sweep.f2, sweep.dur) * sr)] = 0.01;
  ir[pre - Math.round(harmonicOffset(3, sweep.f1, sweep.f2, sweep.dur) * sr)] = 0.004;

  return {
    id: "example", name: "Exemplo simulado", date: Date.now(), kind: "sweep", example: true,
    sr, sweep, ir, peak: pre,
    stats: { latencyMs: 112, peakDb: -9.4, source: "simulado" },
  };
}
