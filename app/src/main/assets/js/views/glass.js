// "Taça": find a glass's resonance by tapping, then excite it and measure how it rings.
import * as d from "../dsp.js";
import { openSession, live, gen } from "../audio.js";
import { Plot } from "../plot.js";
import { $, app, emit, on, settings, fmt, fmtSigned, noteLabel, setStatus, sleep } from "../ui.js";

const TEMPLATE = `
<section class="card hero">
  <div class="hero-top"><span class="label">Frequência da taça</span><span class="badge info" id="tBadge" hidden>Ajustada pela busca</span></div>
  <div class="big"><span class="val" id="tF">—</span><span class="unit">Hz</span><span class="tag" id="tNote"></span></div>
  <div class="sub" id="tSub">Bata na taça para descobrir a frequência dela.</div>
</section>

<section class="card">
  <div class="card-head"><h2>1. Ouvir a batida</h2></div>
  <ol class="steps">
    <li>Segure a taça pela haste, a uns 10 cm do microfone.</li>
    <li>Toque em <b>Ouvir batida</b> e bata de leve na borda com a unha ou uma colher.</li>
  </ol>
  <button type="button" class="btn block" id="tTap">Ouvir batida</button>
  <div class="bar level"><i id="tLvl"></i></div>
  <canvas class="chart short" id="tSpec" aria-label="Espectro da batida"></canvas>
  <div class="chips" id="tPartials"></div>
  <p class="status" id="tStatus"></p>
</section>

<section class="card">
  <div class="card-head"><h2>2. Fazer a taça cantar</h2></div>
  <div class="freq-row">
    <button type="button" class="btn" id="eDown" aria-label="Menos 0,1 Hz">−</button>
    <input id="eFreq" type="number" inputmode="decimal" step="0.1" aria-label="Frequência de excitação em Hz">
    <span class="unit">Hz</span>
    <button type="button" class="btn" id="eUp" aria-label="Mais 0,1 Hz">+</button>
  </div>
  <div class="grid">
    <label class="field"><span class="label">Varredura fina</span>
      <select id="eWob"><option value="0">Desligada</option><option value="0.002">±0,2%</option><option value="0.01">±1%</option></select></label>
    <label class="field"><span class="label">Volume <span class="mono" id="eLvlV"></span></span><input type="range" id="eLvl" min="10" max="100" step="5"></label>
  </div>
  <div class="row">
    <button type="button" class="btn primary grow" id="ePlay">Tocar na taça</button>
  </div>
  <div class="row">
    <button type="button" class="btn grow" id="eTest">Excitar e ouvir</button>
    <button type="button" class="btn grow" id="eSearch">Busca automática</button>
  </div>
  <canvas class="chart short" id="eChart" aria-label="Resposta da taça por frequência"></canvas>
  <p class="status" id="eStatus">Aproxime o alto-falante da borda. <b>Excitar e ouvir</b> toca 3 s, para e mede quanto a taça continua soando. A <b>busca automática</b> repete isso em volta da frequência e fica com a melhor.</p>
</section>

<section class="card">
  <div class="card-head"><h2>Afinador ao vivo</h2><button type="button" class="btn small" id="uRun">Ligar</button></div>
  <div class="big"><span class="val" id="uF">—</span><span class="unit">Hz</span><span class="tag" id="uNote"></span></div>
  <div class="cents" title="Desvio em relação à taça"><i id="uCents"></i></div>
  <div class="sub" id="uSub">Mostra o tom mais forte que o microfone ouve (200 Hz–6 kHz) e quanto ele se afasta da frequência da taça.</div>
  <div class="meter"><i id="uMeter"></i></div>
</section>

<p class="note">O alto-falante do celular faz a taça vibrar por simpatia, e dá para ouvi-la soar depois que o tom para. Quebrar uma taça exige mais de 100 dB exatamente na frequência dela, muito além de um celular. Com caixa potente, use óculos e protetor auricular.</p>`;

let root, specPlot, chart, tunerUnsub = null, busy = false;
const results = [];

const target = () => parseFloat($("#eFreq", root).value) || app.glass?.f0 || 800;
const level = () => settings.get("genLevel") / 100;

function setTarget(f) {
  $("#eFreq", root).value = (Math.round(f * 100) / 100).toFixed(2);
  if (gen.playing && gen.params?.wave === "sine") gen.play({ wave: "sine", f, level: level(), wobble: +$("#eWob", root).value });
}

function renderHero() {
  const g = app.glass;
  $("#tF", root).textContent = g ? fmt(g.f0, 2) : "—";
  $("#tNote", root).textContent = g ? noteLabel(g.f0) : "";
  $("#tSub", root).textContent = g
    ? `${Number.isFinite(g.q) ? `Q ≈ ${fmt(g.q, 0)} · ` : ""}${Number.isFinite(g.t60) ? `soa por ${fmt(g.t60, 1)} s (−60 dB)` : ""}`
    : "Bata na taça para descobrir a frequência dela.";
  $("#tBadge", root).hidden = !g?.refined;
}

/* ---------- 1. Tap ---------- */
async function tap() {
  if (busy) return;
  busy = true;
  stopTuner(); gen.stop();
  const btn = $("#tTap", root), status = $("#tStatus", root);
  btn.disabled = true; btn.textContent = "Ouvindo… bata na taça";
  let session;
  try {
    session = await openSession();
    const rec = await session.listen(4, (_, lvl) => { $("#tLvl", root).style.width = Math.max(0, Math.min(100, (lvl + 60) / 60 * 100)) + "%"; });
    const r = d.analyzeTap(rec, session.sampleRate);
    app.glass = { ...r, refined: false };
    emit("glass", app.glass);
    setTarget(r.f0);
    renderHero(); renderSpectrum();
    setStatus(status, "Pronto. Agora toque na taça com o alto-falante.", "ok");
  } catch (e) {
    setStatus(status, e.message, "err");
  } finally {
    session?.close();
    btn.disabled = false; btn.textContent = "Ouvir batida";
    $("#tLvl", root).style.width = "0%";
    busy = false;
  }
}

function renderSpectrum() {
  const g = app.glass;
  if (!g?.spectrum) return;
  specPlot.set({
    xType: "log", x: [g.grid[0], g.grid.at(-1)], y: [-60, 0], yStep: 20,
    series: [{ x: g.grid, y: g.spectrum, color: "--accent", fill: true, label: "" }],
    markers: g.peaks.slice(0, 4).map((p, i) => ({ x: p.f, y: d.interpLog(g.grid, g.spectrum, p.f), label: i ? "" : `${fmt(p.f, 1)}`, big: !i })),
  });
  $("#tPartials", root).innerHTML = g.peaks.slice(1).map(p => `<span class="chip">${fmt(p.f, 0)} Hz · ${fmt(p.f / g.f0, 2)}× · ${fmt(p.db, 0)} dB</span>`).join("");
}

/* ---------- 2. Excite & listen ---------- */

/** Collects live samples with a running index so tone stop times can be located. */
function collector() {
  const blocks = [];
  let count = 0;
  const fn = b => { blocks.push(b); count += b.length; };
  return {
    fn,
    get count() { return count; },
    slice(from, to) {
      const out = new Float32Array(Math.max(0, to - from));
      let pos = 0;
      for (const b of blocks) {
        const s = Math.max(from, pos), e = Math.min(to, pos + b.length);
        if (e > s) out.set(b.subarray(s - pos, e - pos), s - from);
        pos += b.length;
      }
      return out;
    },
  };
}

/** Plays f for exciteSec, stops, and measures the glass's ring at f relative to the noise floor. */
async function exciteOnce(f, col, { exciteSec = 3, listenSec = 1.2 } = {}) {
  const sr = live.sampleRate;
  const n0 = col.count;
  await sleep(400);
  const noiseSeg = col.slice(n0, col.count);
  const noise = noiseSeg.length > 960 ? d.goertzel(noiseSeg, 0, noiseSeg.length, f, sr) : 1e-6;

  await gen.play({ wave: "sine", f, level: level(), wobble: 0 });
  await sleep(exciteSec * 1000);
  const playEnd = col.count;
  const direct = d.goertzel(col.slice(playEnd - sr / 4, playEnd), 0, sr / 4, f, sr);
  gen.stop();
  const stopAt = col.count;
  await sleep(listenSec * 1000);

  // Skip output latency and the room's own reverberation before reading the ring.
  const ring = col.slice(stopAt + Math.round(0.25 * sr), stopAt + Math.round(listenSec * sr));
  const amp = ring.length > 960 ? d.goertzel(ring, 0, Math.min(ring.length, Math.round(0.3 * sr)), f, sr) : 0;
  const decay = ring.length > sr / 2 ? d.toneDecay(ring, 0, ring.length, f, sr, 30) : null;
  return { f, ringDb: d.db20(amp / Math.max(noise, 1e-9)), relDirect: d.db20(amp / Math.max(direct, 1e-9)), t60: decay?.t60 };
}

async function withLive(task) {
  if (busy) return;
  busy = true;
  stopTuner();
  const col = collector(), status = $("#eStatus", root);
  let unsub = null;
  ["#eTest", "#eSearch", "#tTap"].forEach(s => { $(s, root).disabled = true; });
  try {
    unsub = await live.subscribe(col.fn);
    await task(col, status);
  } catch (e) {
    setStatus(status, e.message, "err");
  } finally {
    gen.stop();
    unsub?.();
    ["#eTest", "#eSearch", "#tTap"].forEach(s => { $(s, root).disabled = false; });
    busy = false;
  }
}

const verdict = r => r.ringDb >= 12 ? "A taça cantou forte!" : r.ringDb >= 6 ? "A taça respondeu." : r.ringDb >= 3 ? "Resposta fraca." : "Nenhuma resposta acima do ruído.";

async function test() {
  await withLive(async (col, status) => {
    const f = target();
    setStatus(status, `Excitando ${fmt(f, 2)} Hz…`);
    const r = await exciteOnce(f, col);
    results.push(r); renderChart();
    setStatus(status, `${verdict(r)} Soou ${fmt(r.ringDb, 1)} dB acima do ruído depois que o tom parou${Number.isFinite(r.t60) && r.t60 > 0 ? `, decaindo em ${fmt(r.t60, 1)} s` : ""}.`, r.ringDb >= 6 ? "ok" : "warn");
  });
}

async function search() {
  await withLive(async (col, status) => {
    const f0 = target(), q = app.glass?.q, bw = Number.isFinite(q) && q > 0 ? f0 / q : f0 / 1000;
    const stepHz = Math.max(0.1, Math.min(2, bw / 2)), offsets = [-3, -2, -1, 0, 1, 2, 3];
    results.length = 0;
    for (let i = 0; i < offsets.length; i++) {
      const f = f0 + offsets[i] * stepHz;
      setStatus(status, `Busca ${i + 1}/${offsets.length}: ${fmt(f, 2)} Hz…`);
      results.push(await exciteOnce(f, col, { exciteSec: 2.5, listenSec: 1 }));
      renderChart();
    }
    const best = results.reduce((a, b) => (b.ringDb > a.ringDb ? b : a));
    if (best.ringDb >= 3) {
      setTarget(best.f);
      if (app.glass) { app.glass = { ...app.glass, f0: best.f, refined: true }; emit("glass", app.glass); renderHero(); }
      setStatus(status, `Melhor resposta em ${fmt(best.f, 2)} Hz (${fmtSigned(best.f - f0, 2)} Hz da batida), ${fmt(best.ringDb, 1)} dB acima do ruído. ${verdict(best)}`, "ok");
    } else {
      setStatus(status, "Nenhuma frequência fez a taça responder acima do ruído. Aproxime o alto-falante da borda e aumente o volume.", "warn");
    }
  });
}

function renderChart() {
  if (!results.length) { chart.set({ series: [] }); return; }
  const fs = results.map(r => r.f), lo = Math.min(...fs), hi = Math.max(...fs), span = Math.max(1, hi - lo), w = span / Math.max(4, results.length) / 2;
  const top = Math.max(15, ...results.map(r => r.ringDb + 3));
  chart.set({
    xType: "lin", x: [lo - span * 0.15, hi + span * 0.15], y: [0, Math.ceil(top / 5) * 5], yStep: 5,
    xTick: v => fmt(v, 1), yTick: v => fmt(v, 0), fmtX: v => `${fmt(v, 2)} Hz`, fmtY: v => `${fmt(v, 1)} dB acima do ruído`,
    series: [{ bars: results.map(r => ({ lo: r.f - w, hi: r.f + w, v: Math.max(0, r.ringDb), color: r.ringDb >= 6 ? "--accent" : "--muted" })), base: 0, label: "" }],
  });
}

/* ---------- Tuner ---------- */
const tuneRing = new Float32Array(16384);
let tunePos = 0, tuneFill = 0, tuneTick = 0;

function tunerBlock(b) {
  for (let i = 0; i < b.length; i++) { tuneRing[tunePos] = b[i]; tunePos = (tunePos + 1) % tuneRing.length; }
  tuneFill = Math.min(tuneRing.length, tuneFill + b.length);
  if (++tuneTick % 3 || tuneFill < tuneRing.length) return;
  const frame = new Float32Array(tuneRing.length);
  for (let i = 0; i < frame.length; i++) frame[i] = tuneRing[(tunePos + i) % tuneRing.length];
  const { P, df } = d.powerSpectrum(frame, live.sampleRate, 65536), dom = d.dominant(P, df, 200, 6000);
  if (!dom) return;
  $("#uF", root).textContent = fmt(dom.f, 2);
  $("#uNote", root).textContent = noteLabel(dom.f);
  $("#uMeter", root).style.width = Math.max(0, Math.min(100, (dom.db + 90) / 80 * 100)) + "%";
  const ref = app.glass?.f0 ?? target(), cents = 1200 * Math.log2(dom.f / ref);
  $("#uCents", root).style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
  $("#uSub", root).textContent = `${fmtSigned(dom.f - ref, 2)} Hz (${fmtSigned(cents, 0)}¢) da taça · ${fmt(dom.db, 0)} dBFS`;
}

async function toggleTuner() {
  if (tunerUnsub) return stopTuner();
  try { tuneFill = 0; tunerUnsub = await live.subscribe(tunerBlock); } catch (e) { $("#uSub", root).textContent = e.message; }
  $("#uRun", root).textContent = tunerUnsub ? "Desligar" : "Ligar";
}

function stopTuner() {
  tunerUnsub?.(); tunerUnsub = null;
  if (root) $("#uRun", root).textContent = "Ligar";
}

function renderPlay() {
  const playing = gen.playing && gen.params?.wave === "sine" && !busy;
  $("#ePlay", root).textContent = playing ? "Parar" : "Tocar na taça";
  $("#ePlay", root).classList.toggle("playing", playing);
}

export default {
  id: "taca", title: "Taça", icon: "glass", tab: true,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    specPlot = new Plot($("#tSpec", root), { pad: { l: 36, r: 10, t: 12, b: 22 } });
    chart = new Plot($("#eChart", root), { xType: "lin", pad: { l: 36, r: 10, t: 12, b: 22 } });
    setTarget(app.glass?.f0 ?? 800);
    $("#eLvl", root).value = settings.get("genLevel");
    $("#eLvlV", root).textContent = settings.get("genLevel") + "%";
    $("#tTap", root).onclick = tap;
    $("#eDown", root).onclick = () => setTarget(target() - 0.1);
    $("#eUp", root).onclick = () => setTarget(target() + 0.1);
    $("#eFreq", root).onchange = () => setTarget(target());
    $("#eWob", root).onchange = () => setTarget(target());
    $("#eLvl", root).oninput = e => { settings.set("genLevel", +e.target.value); $("#eLvlV", root).textContent = e.target.value + "%"; setTarget(target()); };
    $("#ePlay", root).onclick = () => {
      if (gen.playing) gen.stop();
      else gen.play({ wave: "sine", f: target(), level: level(), wobble: +$("#eWob", root).value });
    };
    $("#eTest", root).onclick = test;
    $("#eSearch", root).onclick = search;
    $("#uRun", root).onclick = toggleTuner;
    on("gen", () => root && renderPlay());
    on("live", ({ running }) => { if (!running) tunerUnsub = null; if (root) $("#uRun", root).textContent = tunerUnsub ? "Desligar" : "Ligar"; });
    renderHero(); renderChart(); renderPlay();
    specPlot.set({ x: [200, 10000], y: [-60, 0], yStep: 20, series: [] });
  },
  show() { renderHero(); renderSpectrum(); },
  hide() { stopTuner(); },
};
