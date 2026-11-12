// "Histórico": saved measurements, overlay comparison, averaging, reference and export.
import * as d from "../dsp.js";
import * as A from "../analysis.js";
import * as store from "../store.js";
import { shareFile } from "../audio.js";
import { Plot } from "../plot.js";
import { setCurrent } from "./measure.js";
import { $, app, emit, on, settings, fmt, fmtHz, fmtDate, toast } from "../ui.js";

const COLORS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];

const TEMPLATE = `
<section class="card">
  <div class="card-head"><h2>Comparar</h2>
    <div class="group row"><select class="inline" id="hSmooth" aria-label="Suavização"><option value="6">1/6 oit.</option><option value="12" selected>1/12 oit.</option><option value="24">1/24 oit.</option></select>
    <select class="inline" id="hRange" aria-label="Faixa"><option value="20,20000">Completo</option><option value="20,2000">20 Hz–2 kHz</option><option value="20,300">Graves</option></select></div>
  </div>
  <canvas class="chart tall" id="hPlot" aria-label="Comparação de medições"></canvas>
  <div class="legend" id="hLegend"></div>
  <div class="row">
    <button type="button" class="btn small" id="hAvg" disabled>Média das selecionadas</button>
    <span class="note" id="hHint">Toque no quadrado colorido para incluir uma medição na comparação.</span>
  </div>
</section>

<section class="card">
  <div class="card-head"><h2>Medições</h2><span class="label" id="hCount"></span></div>
  <div class="hist-list" id="hList"></div>
</section>`;

let root, plot, items = [];
const selected = new Set();

let known = null;

async function load() {
  items = await store.list();
  for (const id of [...selected]) if (!items.some(m => m.id === id)) selected.delete(id);
  if (known === null) items.slice(0, 2).forEach(m => selected.add(m.id));
  // New measurements join the comparison automatically (up to six curves).
  else items.filter(m => !known.has(m.id)).forEach(m => { if (selected.size < COLORS.length) selected.add(m.id); });
  known = new Set(items.map(m => m.id));
  render();
}

function colorOf(id) {
  const idx = [...selected].indexOf(id);
  return idx >= 0 ? COLORS[idx % COLORS.length] : null;
}

function render() {
  $("#hCount", root).textContent = items.length ? `${items.length} salvas` : "";
  renderList(); renderPlot();
}

function renderPlot() {
  const frac = +$("#hSmooth", root).value, x = $("#hRange", root).value.split(",").map(Number);
  const chosen = items.filter(m => selected.has(m.id));
  const series = chosen.map(m => ({ y: A.response(m, { frac, normalize: true }), color: colorOf(m.id), width: 2, label: m.name.slice(0, 18) }));
  plot.set({ xType: "log", x, y: [-45, 5], yStep: 10, series });
  $("#hLegend", root).innerHTML = chosen.map(m => `<span><i style="background:var(${colorOf(m.id)})"></i>${escapeHtml(m.name)}</span>`).join("");
  $("#hAvg", root).disabled = chosen.length < 2;
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function summary(m) {
  const pk = A.peaks(m)[0], rt = m.kind === "sweep" ? d.bestRT(A.broadbandDecay(m)) : NaN;
  return [m.kind === "avg" ? "média" : null, fmtDate(m.date), pk ? `pico ${fmtHz(pk.f)}` : null, Number.isFinite(rt) ? `RT ${fmt(rt, 2)} s` : null].filter(Boolean).join(" · ");
}

function renderList() {
  const list = $("#hList", root), refId = settings.get("refId");
  if (!items.length) {
    list.innerHTML = `<p class="empty">Nenhuma medição salva ainda. Cada medição feita na aba Medir aparece aqui para comparar, renomear e exportar.</p>`;
    return;
  }
  list.innerHTML = "";
  for (const m of items) {
    const c = colorOf(m.id), row = document.createElement("div");
    row.className = "hist-item";
    row.innerHTML = `
      <button type="button" class="swatch" aria-pressed="${!!c}" aria-label="Comparar ${escapeHtml(m.name)}" style="${c ? `background:var(${c})` : ""}"></button>
      <div style="min-width:0"><div class="name">${escapeHtml(m.name)}${m.id === refId ? ' <span class="badge info">Referência</span>' : ""}${app.current?.id === m.id ? ' <span class="badge ok">Aberta</span>' : ""}</div><div class="info">${summary(m)}</div></div>
      <div class="hist-actions">
        <button type="button" class="btn" data-a="open">Abrir</button>
        <button type="button" class="btn" data-a="more" aria-expanded="false">⋯</button>
      </div>`;
    const more = document.createElement("div");
    more.className = "row"; more.hidden = true; more.style.gridColumn = "1 / -1";
    more.innerHTML = `
      <button type="button" class="btn small" data-a="rename">Renomear</button>
      <button type="button" class="btn small" data-a="ref">${m.id === refId ? "Remover referência" : "Usar como referência"}</button>
      <button type="button" class="btn small" data-a="csv">CSV</button>
      ${m.ir ? '<button type="button" class="btn small" data-a="wav">IR (WAV)</button>' : ""}
      <button type="button" class="btn small danger" data-a="del">Excluir</button>`;
    row.appendChild(more);

    row.querySelector(".swatch").onclick = () => { selected.has(m.id) ? selected.delete(m.id) : selected.add(m.id); render(); };
    row.querySelector('[data-a="open"]').onclick = () => { setCurrent(m); location.hash = "#medir"; };
    row.querySelector('[data-a="more"]').onclick = e => { more.hidden = !more.hidden; e.currentTarget.setAttribute("aria-expanded", String(!more.hidden)); };
    more.querySelector('[data-a="rename"]').onclick = () => rename(row, m);
    more.querySelector('[data-a="ref"]').onclick = () => { settings.set("refId", m.id === refId ? null : m.id); renderList(); toast(m.id === refId ? "Referência removida" : "Referência definida. Use-a em Medir › Resposta."); };
    more.querySelector('[data-a="csv"]').onclick = () => exportCsv(m);
    more.querySelector('[data-a="wav"]')?.addEventListener("click", () => shareFile(`${fileName(m)}-ir.wav`, "audio/wav", d.wavFloat32(m.ir.subarray(Math.max(0, m.peak - 480)), m.sr)));
    more.querySelector('[data-a="del"]').onclick = e => confirmDelete(e.currentTarget, m);
    list.appendChild(row);
  }
}

function rename(row, m) {
  const name = row.querySelector(".name");
  const input = document.createElement("input");
  input.className = "rename"; input.value = m.name; input.maxLength = 60; input.setAttribute("aria-label", "Novo nome");
  name.replaceWith(input);
  input.focus(); input.select();
  const done = async save => {
    if (save && input.value.trim()) { m.name = input.value.trim(); await store.put(m); emit("history-changed"); if (app.current?.id === m.id) setCurrent(m); }
    render();
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
  input.addEventListener("blur", () => done(true), { once: true });
}

function confirmDelete(btn, m) {
  if (btn.dataset.confirm) {
    store.del(m.id).then(() => {
      selected.delete(m.id);
      if (settings.get("refId") === m.id) settings.set("refId", null);
      toast("Medição excluída");
      emit("history-changed");
      load();
    });
    return;
  }
  btn.dataset.confirm = "1";
  btn.textContent = "Tocar de novo para excluir";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = "Excluir"; } }, 4000);
}

const fileName = m => m.name.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "medicao";

function exportCsv(m) {
  const c = A.response(m, { frac: 48, normalize: false }), rows = ["freq_hz;nivel_db"];
  for (let i = 0; i < d.GRID.length; i++) if (Number.isFinite(c[i])) rows.push(`${d.GRID[i].toFixed(2)};${c[i].toFixed(2)}`);
  shareFile(`${fileName(m)}.csv`, "text/csv", rows.join("\n") + "\n");
}

async function makeAverage() {
  const chosen = items.filter(m => selected.has(m.id));
  if (chosen.length < 2) return;
  const avg = { ...A.averageOf(chosen, `Média de ${chosen.length} posições`), id: store.newId() };
  await store.put(avg);
  selected.clear(); selected.add(avg.id);
  toast("Média criada e aberta em Medir");
  emit("history-changed");
  await load();
  setCurrent(avg);
}

export default {
  id: "historico", title: "Histórico", icon: "history", tab: false,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    plot = new Plot($("#hPlot", root));
    $("#hSmooth", root).onchange = renderPlot;
    $("#hRange", root).onchange = renderPlot;
    $("#hAvg", root).onclick = makeAverage;
    on("history-changed", () => root && !root.hidden && load());
    load();
  },
  show() { load(); },
  hide() {},
};
