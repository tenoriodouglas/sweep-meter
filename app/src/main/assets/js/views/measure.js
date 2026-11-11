// "Medir": sweep measurement with response, impulse, waterfall, RT60, distortion and auto-EQ.
import * as d from "../dsp.js";
import * as A from "../analysis.js";
import * as store from "../store.js";
import { openSession, shareFile, gen, TAIL } from "../audio.js";
import { Plot, drawWaterfall } from "../plot.js";
import { exampleMeasurement } from "../example.js";
import { $, app, emit, on, settings, fmt, fmtHz, fmtSigned, noteLabel, fmtDate, setStatus, segmented, toast, nextFrame, copyText } from "../ui.js";

const SUBVIEWS = [
  ["resp", "Resposta"], ["imp", "Impulso"], ["wf", "Cascata"], ["rt", "RT60"], ["dist", "Distorção"], ["eq", "EQ"],
];

const TEMPLATE = `
<section class="card hero" aria-live="polite">
  <div class="hero-top">
    <span class="label">Ressonância dominante</span>
    <span class="badge" id="mBadge">Exemplo simulado</span>
  </div>
  <div class="big"><span class="val" id="mF">—</span><span class="unit">Hz</span><span class="tag" id="mNote"></span></div>
  <div class="sub" id="mSub"></div>
  <div class="meta">
    <div><span class="label">RT60 médio</span><span class="num" id="mRT">—</span></div>
    <div><span class="label">Faixa dinâmica</span><span class="num" id="mDyn">—</span></div>
    <div><span class="label">Pico de entrada</span><span class="num" id="mPeak">—</span></div>
    <div><span class="label">Latência</span><span class="num" id="mLat">—</span></div>
  </div>
</section>

<div class="seg sticky" id="mSeg">${SUBVIEWS.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}</div>

<section class="card">
  <div class="tools" id="mTools"></div>
  <canvas class="chart tall" id="mPlot" aria-label="Gráfico da análise"></canvas>
  <canvas class="chart tall" id="mWater" hidden aria-label="Cascata de decaimento espectral"></canvas>
  <div class="legend" id="mLegend"></div>
  <div id="mExtra"></div>
</section>

<section class="card">
  <button type="button" class="btn primary block" id="mRun">Medir</button>
  <div class="bars">
    <div class="bar" title="Progresso"><i id="mProg"></i></div>
    <div class="bar level" title="Nível do microfone"><i id="mLvl"></i></div>
  </div>
  <p class="status" id="mStatus">Deixe o celular parado, faça silêncio e toque em Medir. Cada medição vai para o histórico.</p>
</section>

<details class="card">
  <summary>Parâmetros da medição</summary>
  <div class="grid">
    <label class="field"><span class="label">Início (Hz)</span><input id="pf1" type="number" min="10" max="1000"></label>
    <label class="field"><span class="label">Fim (Hz)</span><input id="pf2" type="number" min="1000" max="22000"></label>
    <label class="field"><span class="label">Duração (s)</span><input id="pdur" type="number" min="2" max="20" step="1"></label>
    <label class="field"><span class="label">Volume (%)</span><input id="plevel" type="number" min="5" max="100" step="5"></label>
    <label class="field"><span class="label">Repetições</span><input id="preps" type="number" min="1" max="8" step="1"></label>
    <label class="field"><span class="label">Janela (resposta)</span>
      <select id="pwin"><option value="0.05">50 ms</option><option value="0.2">200 ms</option><option value="0.5">500 ms</option><option value="1">1 s</option></select></label>
    <label class="field"><span class="label">Picos de (Hz)</span><input id="ppLo" type="number" min="10"></label>
    <label class="field"><span class="label">até (Hz)</span><input id="ppHi" type="number" min="20"></label>
  </div>
  <p class="note">Repetições são alinhadas pelo pico e somadas, o que melhora a relação sinal-ruído. Janela curta (50 ms) mostra o alto-falante sem a sala; 500 ms a 1 s mostra os modos da sala.</p>
</details>`;

let root, plot, sub = "resp", busy = false;
const ui = { range: "full", impMode: "imp", impMs: 200, wfPreset: "bass", rtMode: "bands", eqTarget: "flat", eqRange: 300, eqMax: 8, useRef: false };
let reference = null;

const m = () => app.current;

/* ---------- Summary ---------- */
function renderHero() {
  const cur = m(), pk = A.peaks(cur)[0], stats = cur.stats || {};
  $("#mBadge", root).hidden = !cur.example && cur.kind !== "avg";
  $("#mBadge", root).textContent = cur.example ? "Exemplo simulado" : "Média espacial";
  $("#mF", root).textContent = pk ? fmt(pk.f, 1) : "—";
  $("#mNote", root).textContent = pk ? noteLabel(pk.f) : "";
  $("#mSub", root).textContent = (pk ? `+${fmt(pk.prom, 1)} dB acima do entorno${pk.q ? ` · Q ${fmt(pk.q, 1)}` : ""} · ` : "nenhum pico ≥ 3 dB · ") + `${cur.name} · ${fmtDate(cur.date)}`;
  const bb = A.broadbandDecay(cur);
  $("#mRT", root).textContent = bb ? `${fmt(d.bestRT(bb), 2)} s` : "—";
  $("#mDyn", root).textContent = bb ? `${fmt(bb.dynRange, 0)} dB` : "—";
  $("#mPeak", root).textContent = Number.isFinite(stats.peakDb) ? `${fmt(stats.peakDb, 1)} dBFS` : "—";
  $("#mLat", root).textContent = Number.isFinite(stats.latencyMs) ? `${fmt(stats.latencyMs, 0)} ms` : "—";
}

/* ---------- Sub-views ---------- */
const RANGES = { full: [20, 20000], mid: [20, 2000], bass: [20, 300] };

function tools(html) { $("#mTools", root).innerHTML = html; }
function extra(html) { $("#mExtra", root).innerHTML = html; }
function legend(items) {
  $("#mLegend", root).innerHTML = items.map(([c, t]) => `<span><i style="background:var(${c})"></i>${t}</span>`).join("");
}
function showWater(on) { $("#mPlot", root).hidden = on; $("#mWater", root).hidden = !on; }

function renderResp() {
  showWater(false);
  const hasRef = !!settings.get("refId") && !!reference && reference.id !== m().id;
  tools(`
    <div class="seg small" id="tRange"><button data-v="full">Completo</button><button data-v="mid">20 Hz–2 kHz</button><button data-v="bass">Graves</button></div>
    <div class="group">
      <select class="inline" id="tSmooth" aria-label="Suavização">${[3, 6, 12, 24, 48].map(v => `<option value="${v}">1/${v} oit.</option>`).join("")}</select>
      <label class="check"><input type="checkbox" id="tNorm"> Normalizar</label>
      ${hasRef ? `<label class="check"><input type="checkbox" id="tRef"> − ${reference.name}</label>` : ""}
    </div>`);
  segmented($("#tRange", root), v => { ui.range = v; renderResp(); }, ui.range);
  $("#tSmooth", root).value = String(settings.get("smooth"));
  $("#tSmooth", root).onchange = e => { settings.set("smooth", +e.target.value); renderResp(); renderHero(); };
  $("#tNorm", root).checked = settings.get("normalize");
  $("#tNorm", root).onchange = e => { settings.set("normalize", e.target.checked); renderResp(); };
  if (hasRef) { $("#tRef", root).checked = ui.useRef; $("#tRef", root).onchange = e => { ui.useRef = e.target.checked; renderResp(); }; }

  const curve = A.response(m(), { ref: hasRef && ui.useRef ? reference : null });
  const top = Math.ceil((d.maxIn(curve, 20, 20000) + 3) / 5) * 5;
  const pk = A.peaks(m());
  const modes = settings.get("roomExample") ? [] : d.roomModes(settings.get("roomL"), settings.get("roomW"), settings.get("roomH"), RANGES[ui.range][1], d.speedOfSound(settings.get("temp"))).filter(x => x.type === "axial");
  plot.set({
    xType: "log", x: RANGES[ui.range], y: [top - 50, top], yStep: 10, fmtY: v => `${fmt(v, 1)} dB`,
    series: [{ y: curve, color: "--accent", fill: true, label: "" }],
    markers: [
      ...modes.map(x => ({ x: x.f, label: `${"CLA"[x.n.findIndex(v => v > 0)]}${Math.max(...x.n)}` })),
      ...pk.slice(0, 3).map((p, i) => ({ x: p.f, y: d.interpLog(d.GRID, curve, p.f), label: fmtHz(p.f), big: i === 0 })),
    ],
  });
  legend(modes.length ? [["--accent", "Resposta"], ["--mode", "Modos axiais (C/L/A)"]] : [["--accent", "Resposta"]]);

  const rows = pk.map((p, i) => `<tr><td>${i + 1}</td><td>${fmt(p.f, 1)} Hz</td><td>${noteLabel(p.f)}</td><td>+${fmt(p.prom, 1)} dB</td><td>${p.q ? fmt(p.q, 1) : "—"}</td>
    <td><button type="button" class="chip" data-play="${p.f}">Tocar</button></td></tr>`).join("");
  extra(`<div class="label" style="margin-top:4px">Picos (${settings.get("pLo")}–${settings.get("pHi")} Hz)</div>
    <div class="tbl"><table><thead><tr><th>#</th><th>Frequência</th><th>Nota</th><th>Proeminência</th><th>Q</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="empty">Nenhum pico com proeminência ≥ 3 dB nessa faixa.</td></tr>`}</tbody></table></div>
    <div class="row"><button type="button" class="btn small" id="xCsv">Exportar CSV</button>${m().ir ? `<button type="button" class="btn small" id="xWav">Exportar IR (WAV)</button>` : ""}</div>`);
  root.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => emit("play-freq", +b.dataset.play)));
  $("#xCsv", root).onclick = exportCsv;
  if (m().ir) $("#xWav", root).onclick = () => shareFile(`${slug(m().name)}-ir.wav`, "audio/wav", d.wavFloat32(m().ir.subarray(Math.max(0, m().peak - 480)), m().sr));
}

function renderImp() {
  showWater(false);
  tools(`<div class="seg small" id="tImp"><button data-v="imp">Impulso</button><button data-v="etc">ETC (dB)</button></div>
    <select class="inline" id="tMs" aria-label="Duração exibida">${[20, 50, 200, 500, 1000].map(v => `<option value="${v}">${v} ms</option>`).join("")}</select>`);
  segmented($("#tImp", root), v => { ui.impMode = v; renderImp(); }, ui.impMode);
  $("#tMs", root).value = String(ui.impMs);
  $("#tMs", root).onchange = e => { ui.impMs = +e.target.value; renderImp(); };
  const v = A.impulseView(m(), ui.impMs), isEtc = ui.impMode === "etc";
  plot.set({
    xType: "lin", x: [-2, ui.impMs], y: isEtc ? [-80, 0] : [-1.05, 1.05], yStep: isEtc ? 10 : 0.5,
    xTick: t => fmt(t, 0), yTick: y => fmt(y, isEtc ? 0 : 1), fmtX: t => `${fmt(t, 2)} ms`, fmtY: y => (isEtc ? `${fmt(y, 1)} dB` : fmt(y, 3)),
    series: [{ x: v.t, y: isEtc ? v.etc : v.y, color: "--accent", width: 1.2, label: "" }], markers: [],
  });
  legend([["--accent", isEtc ? "Envelope de energia (ETC)" : "Resposta ao impulso (normalizada)"]]);
  const refl = isEtc ? reflections(v) : "";
  extra(`<p class="note">O primeiro pico é o som direto; picos depois dele são reflexões. 1 ms ≈ 34 cm de caminho extra.</p>${refl}`);
}

function reflections(v) {
  const out = [];
  for (let i = 1; i < v.t.length - 1 && out.length < 6; i++) {
    if (v.t[i] < 0.5) continue;
    if (v.etc[i] > -20 && v.etc[i] >= v.etc[i - 1] && v.etc[i] >= v.etc[i + 1] && out.every(o => Math.abs(o.t - v.t[i]) > 0.5)) out.push({ t: v.t[i], db: v.etc[i] });
  }
  if (!out.length) return "";
  return `<div class="chips">${out.map(o => `<span class="chip">${fmt(o.t, 2)} ms · ${fmt(o.t * 0.343, 2)} m · ${fmt(o.db, 0)} dB</span>`).join("")}</div>`;
}

function renderWf() {
  if (m().kind === "avg") return unavailable("A cascata precisa da resposta ao impulso; médias guardam só a curva.");
  showWater(true);
  tools(`<div class="seg small" id="tWf"><button data-v="bass">Graves · 300 ms</button><button data-v="mid">Médios · 50 ms</button></div>`);
  segmented($("#tWf", root), v => { ui.wfPreset = v; renderWf(); }, ui.wfPreset);
  const slices = A.waterfall(m(), ui.wfPreset), mid = ui.wfPreset === "mid";
  drawWaterfall($("#mWater", root), slices, { fLo: mid ? 100 : 20, fHi: mid ? 5000 : 300, range: [-40, 0] });
  legend([["--accent", "Início"], ["--mode", mid ? "50 ms" : "300 ms"]]);
  extra(`<p class="note">Cada fatia é o espectro começando mais tarde no decaimento. Cristas que persistem até o fundo são <b>ressonâncias</b> (modos da sala); o resto deve sumir rápido.</p>`);
}

function renderRt() {
  if (m().kind === "avg") return unavailable("RT60 precisa da resposta ao impulso; médias guardam só a curva.");
  showWater(false);
  tools(`<div class="seg small" id="tRt"><button data-v="bands">Por banda</button><button data-v="curve">Curva de Schroeder</button></div>`);
  segmented($("#tRt", root), v => { ui.rtMode = v; renderRt(); }, ui.rtMode);
  const ra = A.roomAcoustics(m());
  if (ui.rtMode === "bands") {
    const bars = ra.bands.map(b => ({ lo: b.fc / Math.SQRT2, hi: b.fc * Math.SQRT2, v: d.bestRT(b) }));
    const maxV = Math.max(0.5, ...bars.map(b => b.v).filter(Number.isFinite));
    plot.set({
      xType: "log", x: [44, 11300], y: [0, Math.ceil(maxV * 5) / 5 + 0.1], yStep: null,
      xTick: f => (f >= 1000 ? `${f / 1000}k` : String(f)), yTick: v => fmt(v, 1), fmtY: v => `${fmt(v, 2)} s`,
      series: [
        { bars, color: "--accent", label: "T30/T20" },
        { x: Float64Array.from(ra.bands, b => b.fc), y: Float64Array.from(ra.bands, b => b.edt?.t60 ?? NaN), color: "--mode", width: 2, label: "EDT" },
      ], markers: [],
    });
    legend([["--accent", "RT60 (T30, ou T20)"], ["--mode", "EDT"]]);
  } else {
    const bb = ra.broadband, s = bb.schroeder, fit = bb.t30 || bb.t20 || bb.edt;
    const tMax = Math.min(s.t.at(-1) || 1, 3) * 1000;
    const fitY = fit ? Float64Array.from(s.t, t => fit.intercept + fit.slope * t) : null;
    plot.set({
      xType: "lin", x: [0, tMax], y: [-70, 0], yStep: 10, xTick: t => fmt(t, 0), yTick: v => fmt(v, 0),
      fmtX: t => `${fmt(t, 0)} ms`, fmtY: v => `${fmt(v, 1)} dB`,
      series: [
        { x: Float64Array.from(s.t, t => t * 1000), y: Float64Array.from(s.L), color: "--accent", label: "" },
        ...(fitY ? [{ x: Float64Array.from(s.t, t => t * 1000), y: fitY, color: "--mode", dash: [5, 4], width: 1.5, label: "Reta" }] : []),
      ], markers: [],
    });
    legend([["--accent", "Integral de Schroeder (banda larga)"], ["--mode", "Regressão usada no RT60"]]);
  }

  const row = (name, b) => `<tr><td>${name}</td><td>${fmtS(b.edt)}</td><td>${fmtS(b.t20)}</td><td>${fmtS(b.t30)}</td><td>${fmt(b.c50, 1)}</td><td>${fmt(b.c80, 1)}</td><td>${fmt(b.d50, 0)}%</td></tr>`;
  const mid = A.midRT(m());
  extra(`<div class="tbl"><table><thead><tr><th>Banda</th><th>EDT</th><th>T20</th><th>T30</th><th>C50 dB</th><th>C80 dB</th><th>D50</th></tr></thead><tbody>
    ${ra.bands.map(b => row(b.fc >= 1000 ? `${b.fc / 1000} kHz` : `${b.fc} Hz`, b)).join("")}
    ${row("Banda larga", ra.broadband)}</tbody></table></div>
    <p class="note"><b>${verdictRT(mid)}</b> RT60 médio (500 Hz–1 kHz) de ${fmt(mid, 2)} s. Referências: estúdio e home theater tratado 0,2–0,4 s; sala de estar 0,4–0,6 s; acima de 1 s o ambiente embola a fala. C50 acima de 0 dB indica boa inteligibilidade.</p>
    <p class="note">Faixa dinâmica do decaimento: ${fmt(ra.broadband.dynRange, 0)} dB. T30 exige 45 dB e T20 exige 35 dB; abaixo disso o valor fica em branco. Aumente o volume ou as repetições.</p>`);
}

const fmtS = fit => (fit ? `${fmt(fit.t60, 2)} s` : "—");
const verdictRT = t => !Number.isFinite(t) ? "Sem dados suficientes." : t < 0.3 ? "Ambiente seco." : t < 0.6 ? "Ambiente equilibrado." : t < 1 ? "Ambiente vivo." : "Ambiente muito reverberante.";

function renderDist() {
  if (m().kind === "avg") return unavailable("Distorção precisa da resposta ao impulso da varredura.");
  showWater(false);
  tools(`<span class="note">Harmônicos separados no tempo pela varredura exponencial (método de Farina).</span>`);
  const ds = A.distortion(m()), { f1, f2 } = m().sweep;
  const pct = db => 100 * 10 ** (db / 20);
  plot.set({
    xType: "log", x: [Math.max(20, f1), Math.min(20000, f2 / 2)], y: [-80, 0], yStep: 10,
    xTick: f => (f >= 1000 ? `${f / 1000}k` : String(f)), yTick: v => fmt(v, 0),
    fmtY: v => `${fmt(v, 1)} dB (${fmt(pct(v), pct(v) < 1 ? 2 : 1)}%)`,
    series: [
      { y: d.smoothCurve(ds.thd, 6), color: "--accent", width: 2.2, label: "THD" },
      { y: d.smoothCurve(ds.harmonics[0].rel, 6), color: "--s2", width: 1.5, label: "H2" },
      { y: d.smoothCurve(ds.harmonics[1].rel, 6), color: "--s3", width: 1.5, label: "H3" },
    ], markers: [],
  });
  legend([["--accent", "THD"], ["--s2", "2º harmônico"], ["--s3", "3º harmônico"]]);
  const at = f => d.interpLog(d.GRID, ds.thd, f);
  extra(`<div class="chips">${[100, 300, 1000, 3000].filter(f => f > f1 && f < f2 / 2).map(f => `<span class="chip">${fmtHz(f)}: ${fmt(pct(at(f)), 2)}%</span>`).join("")}</div>
    <p class="note">Abaixo de 1% (−40 dB) é inaudível na maioria dos casos; acima de 10% (−20 dB) o alto-falante está saturando. Meça com volume moderado. Ruído de fundo também aparece como “distorção”.</p>`);
}

function renderEq() {
  showWater(false);
  tools(`<div class="group">
    <select class="inline" id="tTarget" aria-label="Curva alvo"><option value="flat">Alvo plano</option><option value="house">Curva da casa (+6 dB graves)</option></select>
    <select class="inline" id="tEqHi" aria-label="Faixa corrigida">${[200, 300, 500, 1000].map(v => `<option value="${v}">até ${fmtHz(v)}</option>`).join("")}</select>
    <select class="inline" id="tEqN" aria-label="Número de filtros">${[4, 6, 8, 10].map(v => `<option value="${v}">${v} filtros</option>`).join("")}</select></div>`);
  $("#tTarget", root).value = ui.eqTarget; $("#tEqHi", root).value = String(ui.eqRange); $("#tEqN", root).value = String(ui.eqMax);
  $("#tTarget", root).onchange = e => { ui.eqTarget = e.target.value; renderEq(); };
  $("#tEqHi", root).onchange = e => { ui.eqRange = +e.target.value; renderEq(); };
  $("#tEqN", root).onchange = e => { ui.eqMax = +e.target.value; renderEq(); };

  const curve = A.response(m(), { frac: 12, normalize: true }), lo = Math.max(20, m().sweep.f1);
  const inRange = [...curve].filter((v, i) => d.GRID[i] >= lo && d.GRID[i] <= ui.eqRange && Number.isFinite(v)).sort((a, b) => a - b);
  const ref = inRange[Math.floor(inRange.length / 2)] ?? -10;
  const target = d.targetCurve(ui.eqTarget, ref);
  const { filters, corrected } = d.autoEq(curve, target, { lo, hi: ui.eqRange, maxFilters: ui.eqMax, sr: m().sr });
  const top = Math.ceil((d.maxIn(curve, lo, ui.eqRange * 2) + 3) / 5) * 5;
  plot.set({
    xType: "log", x: [20, Math.min(20000, ui.eqRange * 4)], y: [top - 40, top], yStep: 5, fmtY: v => `${fmt(v, 1)} dB`,
    xTick: f => (f >= 1000 ? `${f / 1000}k` : String(f)), yTick: v => fmt(v, 0),
    series: [
      { y: curve, color: "--muted", width: 1.5, label: "Antes" },
      { y: target, color: "--mode", dash: [5, 4], width: 1.5, label: "Alvo", noReadout: true },
      { y: corrected, color: "--accent", width: 2.2, label: "Depois" },
    ],
    markers: filters.map(f => ({ x: f.fc })),
  });
  legend([["--muted", "Medido"], ["--accent", "Com EQ"], ["--mode", "Alvo"]]);
  const text = d.eqText(filters);
  extra(`<div class="tbl"><table><thead><tr><th>#</th><th>Tipo</th><th>Frequência</th><th>Ganho</th><th>Q</th></tr></thead><tbody>
    ${filters.map((f, i) => `<tr><td>${i + 1}</td><td>PK</td><td>${fmt(f.fc, 1)} Hz</td><td>${fmtSigned(f.gain, 1)} dB</td><td>${fmt(f.q, 2)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nada passa de 1,5 dB acima do alvo nessa faixa.</td></tr>`}
    </tbody></table></div>
    <div class="row"><button type="button" class="btn small" id="xEqCopy">Copiar filtros</button><button type="button" class="btn small" id="xEqShare">Exportar (.txt)</button></div>
    <p class="note">Só cortes: reforçar vales da sala gasta potência e não os preenche. O texto segue o formato do Equalizer APO e do REW, e os valores servem para qualquer DSP paramétrico (rádio, miniDSP, Wavelet).</p>`);
  $("#xEqCopy", root).onclick = () => copyText(text);
  $("#xEqShare", root).onclick = () => shareFile(`${slug(m().name)}-eq.txt`, "text/plain", text + "\n");
}

function unavailable(msg) {
  showWater(false);
  tools("");
  plot.set({ series: [], markers: [] });
  legend([]);
  extra(`<p class="note">${msg}</p>`);
}

const RENDER = { resp: renderResp, imp: renderImp, wf: renderWf, rt: renderRt, dist: renderDist, eq: renderEq };

async function renderSub() {
  if (sub === "rt" || sub === "wf" || sub === "dist") {
    extra(`<p class="note">Calculando…</p>`);
    await nextFrame();
  }
  RENDER[sub]();
}

/* ---------- Measurement ---------- */
function readParams() {
  const n = (id, def, lo, hi) => { const v = parseFloat($(id, root).value); return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : def)); };
  const p = {
    f1: n("#pf1", 30, 10, 1000), f2: n("#pf2", 16000, 1000, 22000), dur: n("#pdur", 6, 2, 20),
    level: n("#plevel", 70, 5, 100), reps: Math.round(n("#preps", 1, 1, 8)), win: parseFloat($("#pwin", root).value),
    pLo: n("#ppLo", 30, 10, 20000), pHi: n("#ppHi", 500, 20, 20000),
  };
  for (const [k, v] of Object.entries(p)) settings.set(k, v);
  return p;
}

function fillParams() {
  for (const k of ["f1", "f2", "dur", "level", "reps", "pLo", "pHi"]) $("#p" + k, root).value = settings.get(k);
  $("#pwin", root).value = String(settings.get("win"));
}

async function measure() {
  if (busy) return;
  busy = true;
  gen.stop();
  const p = readParams(), btn = $("#mRun", root), status = $("#mStatus", root);
  btn.disabled = true;
  let session;
  try {
    session = await openSession();
    const sr = session.sampleRate, f2 = Math.min(p.f2, sr * 0.45), sweep = d.makeSweep(sr, p.f1, f2, p.dur);
    const pre = Math.round((d.harmonicOffset(5, p.f1, f2, p.dur) + 0.05) * sr), post = Math.round((TAIL - 0.2) * sr);
    const acc = new Float32Array(pre + post);
    let peakDb = -Infinity, latency = 0;
    for (let r = 0; r < p.reps; r++) {
      setStatus(status, `Medindo ${r + 1}/${p.reps}… mantenha silêncio.`);
      const rec = await session.capture({ f1: p.f1, f2, dur: p.dur, level: p.level / 100 }, sweep, (frac, lvl) => {
        $("#mProg", root).style.width = ((r + frac) / p.reps * 100) + "%";
        $("#mLvl", root).style.width = Math.max(0, Math.min(100, (lvl + 60) / 60 * 100)) + "%";
      });
      setStatus(status, `Processando ${r + 1}/${p.reps}…`);
      await nextFrame();
      let pk = 0;
      for (let i = 0; i < rec.length; i++) pk = Math.max(pk, Math.abs(rec[i]));
      peakDb = Math.max(peakDb, d.db20(pk));
      const { h, peak } = d.deconvolve(rec, sweep);
      latency += (peak / sr - 0.4) * 1000 / p.reps;
      const ir = d.extractIR(h, peak, pre, post);
      for (let i = 0; i < acc.length; i++) acc[i] += ir[i];
    }
    const scale = 1 / (p.reps * p.level / 100);
    for (let i = 0; i < acc.length; i++) acc[i] *= scale;
    $("#mProg", root).style.width = "100%";

    const meas = {
      id: store.newId(), name: `Medição ${fmtDate(Date.now())}`, date: Date.now(), kind: "sweep",
      sr, sweep: { f1: p.f1, f2, dur: p.dur }, ir: acc, peak: pre,
      stats: { latencyMs: latency, peakDb, source: session.source, reps: p.reps },
    };
    await store.put(meas);
    setCurrent(meas);
    emit("history-changed");
    const dyn = A.broadbandDecay(meas)?.dynRange ?? 0;
    if (peakDb > -1) setStatus(status, "Saturou o microfone. Abaixe o volume e repita.", "warn");
    else if (peakDb < -35) setStatus(status, "Sinal fraco. Aumente o volume ou aproxime a fonte.", "warn");
    else if (dyn < 35) setStatus(status, "Concluído, mas com pouca faixa dinâmica. Use mais repetições ou mais volume para o RT60.", "warn");
    else setStatus(status, `Concluído e salvo no histórico. Entrada: ${session.source}.`, "ok");
  } catch (e) {
    setStatus(status, e.name === "NotAllowedError" ? e.message : "Falha na medição: " + (e?.message || e), "err");
  } finally {
    session?.close();
    btn.disabled = false;
    busy = false;
    $("#mLvl", root).style.width = "0%";
  }
}

/* ---------- Export ---------- */
const slug = s => s.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "medicao";

function exportCsv() {
  const curve = A.response(m(), { frac: 48, normalize: false }), rows = ["freq_hz;nivel_db"];
  for (let i = 0; i < d.GRID.length; i++) if (Number.isFinite(curve[i])) rows.push(`${d.GRID[i].toFixed(2)};${curve[i].toFixed(2)}`);
  rows.push("", "pico_hz;proeminencia_db;q");
  for (const p of A.peaks(m())) rows.push(`${p.f.toFixed(2)};${p.prom.toFixed(2)};${p.q ? p.q.toFixed(2) : ""}`);
  shareFile(`${slug(m().name)}.csv`, "text/csv", rows.join("\n") + "\n");
}

/* ---------- Public ---------- */
export function setCurrent(meas) {
  app.current = meas;
  if (root) { renderHero(); renderSub(); }
  emit("current", meas);
}

async function loadReference() {
  const id = settings.get("refId");
  reference = id ? await store.get(id) : null;
}

export default {
  id: "medir", title: "Medir", icon: "measure", tab: true,
  async mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    plot = new Plot($("#mPlot", root));
    fillParams();
    segmented($("#mSeg", root), v => { sub = v; renderSub(); }, sub);
    $("#mRun", root).addEventListener("click", measure);
    root.querySelectorAll("details input, details select").forEach(x => x.addEventListener("change", () => {
      readParams();
      for (const k of ["win", "pLo", "pHi"]) A.invalidate(m());
      renderHero(); renderSub();
    }));
    on("settings", ({ key }) => {
      if (key === "refId") loadReference().then(() => sub === "resp" && renderSub());
      if (key === "cal") { A.invalidate(m()); renderHero(); renderSub(); }
      if (key.startsWith("room") || key === "temp") sub === "resp" && renderSub();
    });
    await loadReference();
    const last = (await store.list())[0];
    setCurrent(last || exampleMeasurement());
  },
  show() { if (m()) renderSub(); },
  hide() {},
};
