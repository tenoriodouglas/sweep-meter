// "Sala": room mode calculator with Schroeder frequency, Bonello criterion and placement hints.
import * as d from "../dsp.js";
import * as A from "../analysis.js";
import { Plot } from "../plot.js";
import { $, app, on, settings, fmt, fmtHz, noteLabel } from "../ui.js";

const TYPES = { axial: ["Axial", "--accent", 1], tangential: ["Tangencial", "--mode", 0.62], oblique: ["Oblíquo", "--s3", 0.38] };

const TEMPLATE = `
<section class="card">
  <div class="card-head"><h2>Dimensões</h2><span class="badge" id="rBadge">Exemplo</span></div>
  <div class="grid">
    <label class="field"><span class="label">Comprimento (m)</span><input id="rL" type="number" step="0.01" min="1" max="50"></label>
    <label class="field"><span class="label">Largura (m)</span><input id="rW" type="number" step="0.01" min="1" max="50"></label>
    <label class="field"><span class="label">Altura (m)</span><input id="rH" type="number" step="0.01" min="1" max="20"></label>
    <label class="field"><span class="label">Temperatura (°C)</span><input id="rT" type="number" step="1" min="-10" max="45"></label>
    <label class="field"><span class="label">RT60 (s)</span><input id="rRT" type="number" step="0.05" min="0.1" max="5"></label>
  </div>
  <p class="note" id="rRTNote"></p>
</section>

<section class="card hero">
  <div class="meta" style="border-top:0;padding-top:0">
    <div><span class="label">Volume</span><span class="num" id="rVol">—</span></div>
    <div><span class="label">Schroeder</span><span class="num" id="rFs">—</span></div>
    <div><span class="label">1º modo</span><span class="num" id="rF1">—</span></div>
    <div><span class="label">Bonello</span><span class="num" id="rBon">—</span></div>
  </div>
  <p class="note" id="rSummary"></p>
</section>

<section class="card">
  <div class="card-head"><h2>Modos × medição</h2><label class="check"><input type="checkbox" id="rOverlay" checked> Mostrar medição</label></div>
  <canvas class="chart tall" id="rPlot" aria-label="Modos da sala sobre a resposta medida"></canvas>
  <div class="legend"><span><i style="background:var(--accent)"></i>Axial</span><span><i style="background:var(--mode)"></i>Tangencial</span><span><i style="background:var(--s3)"></i>Oblíquo</span><span><i style="background:var(--muted)"></i>Medição atual</span></div>
</section>

<section class="card">
  <h2>Critério de Bonello</h2>
  <canvas class="chart short" id="rBonPlot" aria-label="Modos por banda de terço de oitava"></canvas>
  <p class="note">Modos por banda de 1/3 de oitava. A contagem deve crescer ou se manter de uma banda para a próxima; bandas em laranja quebram a regra ou têm dois modos axiais a menos de 5 Hz (acúmulo).</p>
</section>

<section class="card">
  <h2>Posicionamento</h2>
  <div id="rPlace"></div>
</section>

<section class="card">
  <h2>Lista de modos</h2>
  <div class="tbl"><table><thead><tr><th>Freq.</th><th>Nota</th><th>Tipo</th><th>(c, l, a)</th></tr></thead><tbody id="rTable"></tbody></table></div>
</section>`;

let root, plot, bonPlot;

const dims = () => ({ L: settings.get("roomL"), W: settings.get("roomW"), H: settings.get("roomH") });

function measuredRT() {
  const m = app.current;
  return m && !m.example && m.kind === "sweep" ? A.midRT(m) : NaN;
}

function render() {
  const { L, W, H } = dims(), c = d.speedOfSound(settings.get("temp")), V = L * W * H;
  const mRT = root.hidden ? NaN : measuredRT(), rt = parseFloat($("#rRT", root).value) || 0.4;
  $("#rRTNote", root).textContent = Number.isFinite(mRT) ? `A última medição tem RT60 médio de ${fmt(mRT, 2)} s.` : "Faça uma medição para usar o RT60 real da sala.";
  $("#rBadge", root).hidden = !settings.get("roomExample");

  const fs = d.schroederFreq(rt, V), fmax = Math.max(200, Math.min(500, fs * 1.3));
  const modes = d.roomModes(L, W, H, fmax, c), bon = d.bonello(modes, fs);
  const fails = bon.filter(b => !b.ok || b.clash).length;
  $("#rVol", root).textContent = `${fmt(V, 1)} m³`;
  $("#rFs", root).textContent = fmtHz(fs);
  $("#rF1", root).textContent = modes[0] ? fmtHz(modes[0].f) : "—";
  $("#rBon", root).textContent = fails ? `${fails} alerta${fails > 1 ? "s" : ""}` : "OK";

  const axial = modes.filter(m => m.type === "axial");
  const close = axial.filter((m, i) => axial.some((o, j) => j !== i && Math.abs(o.f - m.f) < 3));
  $("#rSummary", root).textContent = `${modes.length} modos até ${fmtHz(fmax)}. Abaixo de ${fmtHz(fs)} (frequência de Schroeder) a sala se comporta por modos isolados: picos e vales fortes que mudam com a posição. ` +
    (close.length ? `Modos axiais coincidentes perto de ${[...new Set(close.map(m => Math.round(m.f)))].slice(0, 3).join(", ")} Hz reforçam essas frequências.` : "Os modos axiais estão bem distribuídos.");

  // Modes over the measured response
  const cur = app.current, overlay = $("#rOverlay", root).checked && cur;
  const curve = overlay ? A.response(cur, { frac: 12, normalize: true }) : null;
  plot.set({
    xType: "log", x: [15, fmax], y: [-40, 5], yStep: 10,
    series: [
      { stems: modes.map(m => ({ x: m.f, h: TYPES[m.type][2] * 0.85, color: TYPES[m.type][1], width: m.type === "axial" ? 2.5 : 1.5 })) },
      ...(curve ? [{ y: curve, color: "--muted", width: 2, label: "" }] : []),
    ],
    markers: [{ x: fs, label: "Schroeder", color: "--warn" }],
  });

  bonPlot.set({
    xType: "log", x: [17.8, Math.max(40, fs * 1.12)], y: [0, Math.max(4, ...bon.map(b => b.count)) + 1], yStep: null,
    yTick: v => fmt(v, 0), fmtY: v => `${fmt(v, 0)} modos`,
    series: [{ bars: bon.map(b => ({ lo: d.exactCenter(b.fc) / 2 ** (1 / 6), hi: d.exactCenter(b.fc) * 2 ** (1 / 6), v: b.count, color: b.ok && !b.clash ? "--accent" : "--s3" })), base: 0, label: "" }],
  });

  // Placement
  const half = c / (2 * L);
  $("#rPlace", root).innerHTML = `<ul class="steps" style="list-style:disc">
    <li><b>Ouvinte a 38% do comprimento</b>: ${fmt(L * 0.38, 2)} m da parede da frente. Evite o meio da sala (${fmt(L / 2, 2)} m), que é o vale do 1º modo axial de comprimento (${fmt(half, 0)} Hz) e pico do 2º (${fmt(half * 2, 0)} Hz).</li>
    <li><b>Subwoofer</b>: perto de um canto reforça todos os modos (mais grave, menos uniforme); a 1/4 da largura (${fmt(W / 4, 2)} m da parede lateral) cancela o 1º modo de largura (${fmt(c / (2 * W), 0)} Hz).</li>
    <li><b>Caixas</b>: afaste da parede de trás pelo menos ${fmt(c / (4 * 300), 2)} m para empurrar o cancelamento da reflexão (SBIR) abaixo de 300 Hz, ou encoste nela para jogá-lo acima.</li>
    <li><b>Tratamento</b>: armadilhas de grave nos cantos tratam os modos de ${fmtHz(modes[0]?.f ?? 40)} a ${fmtHz(fs)}; painéis porosos de 10 cm só funcionam bem acima de ~${fmtHz(c / (4 * 0.1))}.</li>
  </ul>`;

  const tb = $("#rTable", root);
  tb.innerHTML = modes.slice(0, 40).map(m => `<tr><td>${fmt(m.f, 1)} Hz</td><td>${noteLabel(m.f)}</td><td><span class="chip" style="color:var(${TYPES[m.type][1]});border-color:var(${TYPES[m.type][1]})">${TYPES[m.type][0]}</span></td><td>(${m.n.join(", ")})</td></tr>`).join("");
}

function bind(id, key) {
  const el = $(id, root);
  el.value = settings.get(key);
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    if (!(v > 0) && key !== "temp") return;
    settings.set(key, v);
    if (key.startsWith("room")) settings.set("roomExample", false);
    render();
  });
}

export default {
  id: "sala", title: "Sala", icon: "room", tab: true,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    plot = new Plot($("#rPlot", root), {});
    bonPlot = new Plot($("#rBonPlot", root), { pad: { l: 32, r: 10, t: 10, b: 22 } });
    bind("#rL", "roomL"); bind("#rW", "roomW"); bind("#rH", "roomH"); bind("#rT", "temp");
    $("#rRT", root).value = "0.40";
    $("#rRT", root).addEventListener("input", render);
    $("#rOverlay", root).addEventListener("change", render);
    on("current", () => {
      if (!root || root.hidden) return;
      const v = measuredRT();
      if (Number.isFinite(v)) $("#rRT", root).value = v.toFixed(2);
      render();
    });
    render();
  },
  show() {
    const v = measuredRT();
    if (Number.isFinite(v)) $("#rRT", root).value = v.toFixed(2);
    render();
  },
  hide() {},
};
