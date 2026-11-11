// "Ao vivo": real-time analyzer, spectrogram and SPL meter from the live microphone stream.
import * as d from "../dsp.js";
import { live, gen } from "../audio.js";
import { Plot, Spectrogram } from "../plot.js";
import { $, on, settings, fmt, fmtHz, noteLabel, segmented, setStatus } from "../ui.js";

const TEMPLATE = `
<section class="card hero">
  <div class="hero-top"><span class="label">Nível</span><span class="badge" id="lCal">Não calibrado</span></div>
  <div class="big"><span class="val" id="lSpl">—</span><span class="unit" id="lUnit">dBFS(A)</span></div>
  <div class="sub" id="lDom">Frequência dominante: —</div>
  <div class="meter"><i id="lMeter"></i></div>
  <div class="row">
    <button type="button" class="btn primary grow" id="lRun">Ligar microfone</button>
    <button type="button" class="btn" id="lPink" aria-pressed="false">Ruído rosa</button>
  </div>
  <p class="status" id="lStatus">O microfone fica ligado só nesta tela.</p>
</section>

<div class="seg sticky" id="lSeg"><button data-v="rta">Analisador (RTA)</button><button data-v="spec">Espectrograma</button><button data-v="spl">Decibelímetro</button></div>

<section class="card" id="lRta">
  <div class="tools">
    <div class="seg small" id="lMode"><button data-v="bands">1/3 de oitava</button><button data-v="fft">FFT</button></div>
    <div class="group">
      <select class="inline" id="lAvg" aria-label="Média"><option value="fast">Rápido</option><option value="slow">Lento</option><option value="inf">Média contínua</option></select>
      <label class="check"><input type="checkbox" id="lHold"> Pico</label>
      <button type="button" class="btn small" id="lReset">Zerar</button>
    </div>
  </div>
  <canvas class="chart tall" id="lPlot" aria-label="Analisador de espectro"></canvas>
  <p class="note">Com <b>ruído rosa</b> tocando e média contínua, o RTA mostra a resposta da sala em tempo real: mova a caixa ou o sofá e veja os graves mudarem.</p>
</section>

<section class="card" id="lSpec" hidden>
  <canvas class="chart tall" id="lSpecCanvas" aria-label="Espectrograma"></canvas>
  <p class="note">Tempo corre da direita para a esquerda; cores claras são mais fortes. Linhas horizontais que persistem são tons ou ressonâncias.</p>
</section>

<section class="card" id="lSplCard" hidden>
  <div class="tools">
    <div class="seg small" id="lW"><button data-v="A">dB(A)</button><button data-v="C">dB(C)</button><button data-v="Z">dB(Z)</button></div>
    <div class="seg small" id="lT"><button data-v="fast">Fast 125 ms</button><button data-v="slow">Slow 1 s</button></div>
  </div>
  <div class="meta" style="border-top:0;padding-top:0">
    <div><span class="label">Leq</span><span class="num" id="lLeq">—</span></div>
    <div><span class="label">Máximo</span><span class="num" id="lMax">—</span></div>
    <div><span class="label">Mínimo</span><span class="num" id="lMin">—</span></div>
    <div><span class="label">Tempo</span><span class="num" id="lTime">0 s</span></div>
  </div>
  <canvas class="chart short" id="lHist" aria-label="Histórico de nível"></canvas>
  <button type="button" class="btn small" id="lSplReset">Zerar Leq e extremos</button>
  <p class="note">Sem calibração, os valores são relativos (dBFS). Calibre em Ajustes com um decibelímetro de referência para ler dB SPL.</p>
</section>`;

const FFT_N = 8192, RING = 16384, HIST_SEC = 60;
let root, rta, histPlot, spec, unsub = null, sub = "rta";
const ring = new Float32Array(RING);
let ringPos = 0, filled = 0;
const st = { mode: "bands", avg: "fast", hold: false, tw: "fast", avgP: null, avgN: 0, holdBands: null, holdFft: null, slow: null, leqSum: 0, leqT: 0, max: -Infinity, min: Infinity, hist: [], blocks: 0 };

const offset = () => settings.get("splOffset");
const unitLabel = w => (settings.get("splCalibrated") ? `dB(${w})` : `dBFS(${w})`);

function pushRing(block) {
  for (let i = 0; i < block.length; i++) { ring[ringPos] = block[i]; ringPos = (ringPos + 1) % RING; }
  filled = Math.min(RING, filled + block.length);
}

function lastN(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[(ringPos - n + i + RING) % RING];
  return out;
}

function onBlock(block) {
  const sr = live.sampleRate;
  pushRing(block);
  st.blocks++;
  const blockSec = block.length / sr;

  // SPL (time-weighted, frequency-domain weighting per block)
  const w = settings.get("weight");
  const sp = d.powerSpectrum(block, sr);
  const ms = 10 ** (d.overallLevel(sp.P, sp.df, w) / 10);
  const tau = st.tw === "fast" ? 0.125 : 1, a = 1 - Math.exp(-blockSec / tau);
  st.slow = st.slow == null ? ms : st.slow + (ms - st.slow) * a;
  const level = d.db10(st.slow) + offset();
  st.leqSum += ms * blockSec; st.leqT += blockSec;
  if (st.leqT > 0.5) { st.max = Math.max(st.max, level); st.min = Math.min(st.min, level); }
  st.hist.push(level);
  if (st.hist.length > HIST_SEC / blockSec) st.hist.shift();

  $("#lSpl", root).textContent = fmt(level, 1);
  $("#lMeter", root).style.width = Math.max(0, Math.min(100, (level - offset() + 90) / 90 * 100)) + "%";

  if (filled < FFT_N) return;
  const frame = lastN(FFT_N), { P, df } = d.powerSpectrum(frame, sr);
  const dom = d.dominant(P, df, 20, Math.min(20000, sr / 2 - 100));
  $("#lDom", root).textContent = dom ? `Frequência dominante: ${fmtHz(dom.f)} · ${noteLabel(dom.f)} · ${fmt(dom.db + offset(), 1)} dB` : "Frequência dominante: —";

  // Spectrum averaging
  if (!st.avgP || st.avgP.length !== P.length) { st.avgP = Float64Array.from(P); st.avgN = 1; }
  else if (st.avg === "inf") { st.avgN++; for (let k = 0; k < P.length; k++) st.avgP[k] += (P[k] - st.avgP[k]) / st.avgN; }
  else { const k2 = st.avg === "fast" ? 0.5 : 0.1; for (let k = 0; k < P.length; k++) st.avgP[k] += (P[k] - st.avgP[k]) * k2; }

  if (sub === "rta" && st.blocks % 2 === 0) drawRta(df);
  if (sub === "spec") spec.push(d.powerSpectrum(lastN(4096), sr).P, sr / 4096);
  if (sub === "spl" && st.blocks % 4 === 0) drawSpl();
}

function drawRta(df) {
  const off = offset(), cal = settings.get("splCalibrated");
  const yr = cal ? [10, 110] : [-110, -10];
  if (st.mode === "bands") {
    const bands = d.bandLevels(st.avgP, df, d.THIRD_OCT, 3, "Z").filter(b => b.hi < live.sampleRate / 2);
    if (!st.holdBands || st.holdBands.length !== bands.length) st.holdBands = bands.map(() => -Infinity);
    bands.forEach((b, i) => { st.holdBands[i] = Math.max(st.holdBands[i], b.db + off); });
    rta.set({
      xType: "log", x: [17.8, 22400], y: yr, yStep: 10, fmtY: v => `${fmt(v, 1)} dB`,
      series: [{ bars: bands.map((b, i) => ({ lo: b.lo, hi: b.hi, v: b.db + off, hold: st.hold ? st.holdBands[i] : NaN })), color: "--accent", base: yr[0], label: "" }],
    });
  } else {
    const curve = d.smoothToGrid(st.avgP, df, 24).map(v => v + off);
    if (!st.holdFft) st.holdFft = Float64Array.from(curve);
    for (let i = 0; i < curve.length; i++) st.holdFft[i] = Math.max(st.holdFft[i], curve[i]);
    rta.set({
      xType: "log", x: [20, 20000], y: yr, yStep: 10, fmtY: v => `${fmt(v, 1)} dB`,
      series: [
        ...(st.hold ? [{ y: st.holdFft, color: "--mode", width: 1, label: "Pico" }] : []),
        { y: curve, color: "--accent", fill: true, label: "" },
      ],
    });
  }
}

function drawSpl() {
  const leq = st.leqT ? d.db10(st.leqSum / st.leqT) + offset() : NaN;
  $("#lLeq", root).textContent = `${fmt(leq, 1)} dB`;
  $("#lMax", root).textContent = `${fmt(st.max, 1)} dB`;
  $("#lMin", root).textContent = `${fmt(st.min, 1)} dB`;
  $("#lTime", root).textContent = `${fmt(st.leqT, 0)} s`;
  const n = st.hist.length, dt = 2048 / live.sampleRate;
  const x = Float64Array.from({ length: n }, (_, i) => (i - n + 1) * dt), y = Float64Array.from(st.hist);
  const finite = st.hist.filter(Number.isFinite), hi = Math.ceil((Math.max(...finite, -200) + 5) / 10) * 10;
  histPlot.set({ xType: "lin", x: [-HIST_SEC, 0], y: [hi - 60, hi], yStep: 20, xTick: t => `${fmt(t, 0)}s`, yTick: v => fmt(v, 0), fmtX: t => `${fmt(t, 1)} s`, series: [{ x, y, color: "--accent", fill: true, label: "" }] });
}

function resetAvg() { st.avgP = null; st.avgN = 0; st.holdBands = null; st.holdFft = null; }
function resetSpl() { st.leqSum = 0; st.leqT = 0; st.max = -Infinity; st.min = Infinity; st.hist = []; }

async function start() {
  const status = $("#lStatus", root);
  try {
    resetAvg(); resetSpl(); st.slow = null; filled = 0;
    unsub = await live.subscribe(onBlock);
    setStatus(status, "Microfone ligado.", "ok");
  } catch (e) {
    unsub = null;
    setStatus(status, e.message, "err");
  }
  renderRunBtn();
}

function stop() {
  unsub?.(); unsub = null;
  renderRunBtn();
  setStatus($("#lStatus", root), "Microfone desligado.");
}

function renderRunBtn() {
  const b = $("#lRun", root);
  b.textContent = unsub ? "Desligar microfone" : "Ligar microfone";
  b.classList.toggle("playing", !!unsub);
  $("#lPink", root).setAttribute("aria-pressed", String(gen.playing && gen.params?.wave === "pink"));
  $("#lPink", root).classList.toggle("playing", gen.playing && gen.params?.wave === "pink");
}

function renderCal() {
  const cal = settings.get("splCalibrated"), w = settings.get("weight");
  $("#lCal", root).textContent = cal ? "Calibrado" : "Não calibrado";
  $("#lCal", root).className = "badge" + (cal ? " ok" : "");
  $("#lUnit", root).textContent = unitLabel(w);
}

export default {
  id: "aovivo", title: "Ao vivo", icon: "live", tab: true,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    rta = new Plot($("#lPlot", root), { y: [-110, -10] });
    histPlot = new Plot($("#lHist", root), { xType: "lin", pad: { l: 36, r: 10, t: 8, b: 22 } });
    spec = new Spectrogram($("#lSpecCanvas", root));
    segmented($("#lSeg", root), v => {
      sub = v;
      $("#lRta", root).hidden = v !== "rta"; $("#lSpec", root).hidden = v !== "spec"; $("#lSplCard", root).hidden = v !== "spl";
      if (v === "spec") spec.reset();
    }, sub);
    segmented($("#lMode", root), v => { st.mode = v; resetAvg(); }, st.mode);
    segmented($("#lW", root), v => { settings.set("weight", v); st.slow = null; resetSpl(); renderCal(); }, settings.get("weight"));
    segmented($("#lT", root), v => { st.tw = v; }, st.tw);
    $("#lAvg", root).onchange = e => { st.avg = e.target.value; resetAvg(); };
    $("#lHold", root).onchange = e => { st.hold = e.target.checked; st.holdBands = null; st.holdFft = null; };
    $("#lReset", root).onclick = resetAvg;
    $("#lSplReset", root).onclick = resetSpl;
    $("#lRun", root).onclick = () => (unsub ? stop() : start());
    $("#lPink", root).onclick = () => {
      if (gen.playing && gen.params?.wave === "pink") gen.stop();
      else gen.play({ wave: "pink", f: 1000, level: settings.get("genLevel") / 100, wobble: 0 });
    };
    on("gen", () => root && renderRunBtn());
    on("live", ({ running }) => { if (!running && unsub) { unsub = null; renderRunBtn(); } });
    on("settings", ({ key }) => { if (key.startsWith("spl")) renderCal(); });
    renderCal();
    rta.set({ series: [] });
  },
  show() { renderCal(); renderRunBtn(); },
  hide() { if (unsub) stop(); },
};
