// "Gerador": signal generator with waveforms, fine tuning, note snapping and presets.
import { noteOf } from "../dsp.js";
import { gen } from "../audio.js";
import * as A from "../analysis.js";
import { $, $$, app, on, settings, fmt, fmtHz, noteLabel } from "../ui.js";

const WAVES = [
  ["sine", "Senoide", "M2 11c3-8 6-8 9 0s6 8 9 0 6-8 9 0 6 8 9 0"],
  ["square", "Quadrada", "M2 18V4h10v14h10V4h10v14h8"],
  ["triangle", "Triangular", "M2 18l10-14 10 14 10-14 10 14"],
  ["sawtooth", "Dente de serra", "M2 18L14 4v14L26 4v14L38 4v14"],
  ["white", "Ruído branco", "M2 11l2-6 2 10 2-8 2 5 2-9 2 12 2-7 2 4 2-6 2 9 2-5 2 3 2-8 2 11 2-6 2 4 2-2 2 5"],
  ["pink", "Ruído rosa", "M2 6l2 4 2-2 2 6 2-3 2 5 2-2 2 4 2-1 2 3 2 0 2 2 2 1 2 1 2 1 2 0 2 1 2 0 2 1"],
];

const TEMPLATE = `
<section class="card hero">
  <div class="hero-top"><span class="label">Frequência</span><span class="chip" id="gNote">—</span></div>
  <div class="freq-row">
    <button type="button" class="btn" id="gDown" aria-label="Diminuir">−</button>
    <input id="gFreq" type="number" inputmode="decimal" step="0.1" min="10" max="20000" aria-label="Frequência em Hz">
    <span class="unit">Hz</span>
    <button type="button" class="btn" id="gUp" aria-label="Aumentar">+</button>
  </div>
  <input type="range" id="gSlider" min="0" max="1000" step="1" aria-label="Frequência (escala logarítmica)">
  <div class="row">
    <div class="seg small" id="gStep"><button data-v="0.1">0,1 Hz</button><button data-v="1">1 Hz</button><button data-v="10">10 Hz</button><button data-v="semi">Semitom</button></div>
    <button type="button" class="btn small" id="gSnap">Afinar na nota</button>
  </div>
  <button type="button" class="btn primary block" id="gPlay">Tocar</button>
</section>

<section class="card">
  <span class="label">Forma de onda</span>
  <div class="waves" id="gWaves">${WAVES.map(([v, t, path]) => `<button type="button" class="wave" data-v="${v}"><svg viewBox="0 0 42 22"><path d="${path}"/></svg>${t}</button>`).join("")}</div>
  <div class="grid">
    <label class="field"><span class="label">Volume <span class="mono" id="gLvlV"></span></span><input type="range" id="gLevel" min="1" max="100" step="1"></label>
    <label class="field"><span class="label">Varredura fina</span>
      <select id="gWob"><option value="0">Desligada</option><option value="0.002">±0,2%</option><option value="0.01">±1%</option><option value="0.03">±3%</option></select></label>
  </div>
  <p class="note">A varredura fina oscila a frequência em torno do valor (ciclo de 8 s), útil para acertar ressonâncias estreitas. Não se aplica a ruídos.</p>
</section>

<section class="card">
  <span class="label">Atalhos</span>
  <div class="chips" id="gPresets"></div>
  <p class="note" id="gPeaksNote"></p>
</section>`;

let root;

const freq = () => Math.min(20000, Math.max(10, parseFloat($("#gFreq", root).value) || 100));
const params = () => ({ wave: settings.get("genWave"), f: freq(), level: settings.get("genLevel") / 100, wobble: +settings.get("genWobble") });
const isNoise = () => ["white", "pink"].includes(settings.get("genWave"));

function setFreq(f, apply = true) {
  f = Math.min(20000, Math.max(10, f));
  $("#gFreq", root).value = (Math.round(f * 10) / 10).toFixed(1);
  $("#gSlider", root).value = String(Math.round(Math.log(f / 20) / Math.log(1000) * 1000));
  settings.set("genFreq", f);
  renderNote();
  if (apply && gen.playing) gen.play(params());
}

function renderNote() {
  const f = freq(), n = noteOf(f, settings.get("a4"));
  $("#gNote", root).textContent = isNoise() ? "ruído" : n ? noteLabel(f) : "—";
}

function renderPlay() {
  const b = $("#gPlay", root);
  b.textContent = gen.playing ? "Parar" : "Tocar";
  b.classList.toggle("playing", gen.playing);
}

function renderWaves() {
  $$(".wave", root).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === settings.get("genWave"))));
  const noise = isNoise();
  ["#gFreq", "#gSlider", "#gDown", "#gUp", "#gSnap", "#gWob"].forEach(s => { $(s, root).disabled = noise; });
  renderNote();
}

function renderPresets() {
  const peaks = app.current ? A.peaks(app.current).slice(0, 4) : [];
  const items = [
    ...peaks.map(p => [`${fmtHz(p.f)} (pico)`, () => playSine(p.f)]),
    ...(app.glass ? [[`${fmt(app.glass.f0, 1)} Hz (taça)`, () => playSine(app.glass.f0)]] : []),
    ["1 kHz", () => playSine(1000)], ["Lá 440 Hz", () => playSine(440)], ["50 Hz", () => playSine(50)],
    ["Ruído rosa", () => { settings.set("genWave", "pink"); renderWaves(); gen.play(params()); }],
  ];
  const el = $("#gPresets", root);
  el.innerHTML = "";
  items.forEach(([t, fn]) => { const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = t; b.onclick = fn; el.appendChild(b); });
  $("#gPeaksNote", root).textContent = peaks.length ? `Picos vêm da medição atual (${app.current.name}).` : "";
}

function playSine(f) {
  settings.set("genWave", "sine");
  renderWaves();
  setFreq(f, false);
  gen.play(params());
}

function step(dir) {
  const s = settings.get("genStep"), f = freq();
  setFreq(s === "semi" ? f * 2 ** (dir / 12) : f + dir * +s);
}

export default {
  id: "gerador", title: "Gerador", icon: "generator", tab: true,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    setFreq(settings.get("genFreq"), false);
    $("#gLevel", root).value = settings.get("genLevel");
    $("#gLvlV", root).textContent = settings.get("genLevel") + "%";
    $("#gWob", root).value = String(settings.get("genWobble"));

    $("#gFreq", root).addEventListener("input", () => { settings.set("genFreq", freq()); renderNote(); if (gen.playing) gen.play(params()); });
    $("#gFreq", root).addEventListener("change", () => setFreq(freq()));
    $("#gSlider", root).addEventListener("input", e => setFreq(20 * 1000 ** (e.target.value / 1000)));
    $("#gDown", root).onclick = () => step(-1);
    $("#gUp", root).onclick = () => step(1);
    $("#gSnap", root).onclick = () => { const n = noteOf(freq(), settings.get("a4")); if (n) setFreq(n.freq); };
    const stepSeg = $("#gStep", root);
    stepSeg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      settings.set("genStep", b.dataset.v === "semi" ? "semi" : +b.dataset.v);
      stepSeg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    }));
    stepSeg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(String(settings.get("genStep")) === x.dataset.v)));

    $$(".wave", root).forEach(b => b.addEventListener("click", () => {
      settings.set("genWave", b.dataset.v);
      renderWaves();
      if (gen.playing) gen.play(params());
    }));
    $("#gLevel", root).addEventListener("input", e => {
      settings.set("genLevel", +e.target.value);
      $("#gLvlV", root).textContent = e.target.value + "%";
      if (gen.playing) gen.play(params());
    });
    $("#gWob", root).onchange = e => { settings.set("genWobble", +e.target.value); if (gen.playing) gen.play(params()); };
    $("#gPlay", root).onclick = () => (gen.playing ? gen.stop() : gen.play(params()));

    on("gen", () => root && renderPlay());
    on("current", () => root && renderPresets());
    on("glass", () => root && renderPresets());
    on("play-freq", f => { playSine(f); location.hash = "#gerador"; });
    renderWaves(); renderPlay(); renderPresets();
  },
  show() { renderPresets(); renderPlay(); },
  hide() {},
};

