// "Ajustes": audio devices, microphone calibration, SPL calibration and data.
import * as d from "../dsp.js";
import * as store from "../store.js";
import { NATIVE, devices, setDevices, live, gen } from "../audio.js";
import { $, app, emit, settings, fmt, setStatus, sleep, toast } from "../ui.js";

const TEMPLATE = `
<section class="card">
  <div class="card-head"><h2>Dispositivos de áudio</h2><button type="button" class="btn small" id="sRefresh">Atualizar</button></div>
  <div class="grid">
    <label class="field"><span class="label">Entrada (microfone)</span><select id="sIn"></select></label>
    <label class="field"><span class="label">Saída</span><select id="sOut"></select></label>
  </div>
  <p class="note" id="sDevNote">Conecte um microfone de medição USB (como o UMIK-1) ou uma caixa por P2, USB ou Bluetooth e toque em Atualizar.</p>
</section>

<section class="card">
  <h2>Calibração do microfone</h2>
  <p class="note">Arquivo de calibração (.cal/.txt, formato REW: “frequência ganho” por linha). A correção vale para todas as medições e curvas.</p>
  <div class="row">
    <label class="btn small" for="sCalFile">Importar arquivo</label>
    <input type="file" id="sCalFile" accept=".cal,.txt,.frd,text/plain" hidden>
    <button type="button" class="btn small" id="sCalClear">Remover</button>
  </div>
  <p class="status" id="sCalStatus"></p>
</section>

<section class="card">
  <h2>Calibração de nível (dB SPL)</h2>
  <p class="note">Toque ruído rosa, meça com um decibelímetro de referência ao lado do celular, digite o valor e toque em <b>Calibrar agora</b>. O app mede 3 s e ajusta o deslocamento.</p>
  <div class="grid">
    <label class="field"><span class="label">Leitura de referência (dB)</span><input id="sRef" type="number" step="0.1" placeholder="85.0"></label>
    <label class="field"><span class="label">Ponderação</span><select id="sW"><option value="A">A</option><option value="C">C</option><option value="Z">Z</option></select></label>
    <label class="field"><span class="label">Deslocamento (dB)</span><input id="sOff" type="number" step="0.1"></label>
  </div>
  <div class="row">
    <button type="button" class="btn small" id="sPink">Tocar ruído rosa</button>
    <button type="button" class="btn small" id="sCal">Calibrar agora</button>
    <button type="button" class="btn small" id="sCalReset">Voltar a dBFS</button>
  </div>
  <p class="status" id="sSplStatus"></p>
</section>

<section class="card">
  <h2>Preferências</h2>
  <div class="grid">
    <label class="field"><span class="label">Lá central (Hz)</span><input id="sA4" type="number" step="0.1" min="400" max="480"></label>
    <label class="field"><span class="label">Temperatura (°C)</span><input id="sTemp" type="number" step="1" min="-10" max="45"></label>
  </div>
  <p class="note" id="sC"></p>
</section>

<section class="card">
  <h2>Dados</h2>
  <div class="row"><button type="button" class="btn small danger" id="sWipe">Apagar todo o histórico</button></div>
  <p class="status" id="sWipeStatus"></p>
</section>

<section class="card">
  <h2>Sobre</h2>
  <p class="note" id="sAbout"></p>
  <p class="note">Código: <a href="https://github.com/tenoriodouglas/sweep-meter" target="_blank" rel="noopener">github.com/tenoriodouglas/sweep-meter</a></p>
</section>`;

let root;

function renderDevices() {
  const dv = devices(), opt = (list, sel) => [`<option value="0">Padrão do sistema</option>`, ...list.map(x => `<option value="${x.id}">${x.type}${x.name ? " · " + x.name : ""}</option>`)].join("");
  $("#sIn", root).innerHTML = opt(dv.inputs);
  $("#sOut", root).innerHTML = opt(dv.outputs);
  $("#sIn", root).value = String(settings.get("inputId"));
  $("#sOut", root).value = String(settings.get("outputId"));
  if ($("#sIn", root).value === "") $("#sIn", root).value = "0";
  if ($("#sOut", root).value === "") $("#sOut", root).value = "0";
  if (!NATIVE) $("#sDevNote", root).textContent = "No navegador, escolha os dispositivos nas configurações do sistema.";
}

function applyDevices() {
  settings.set("inputId", +$("#sIn", root).value);
  settings.set("outputId", +$("#sOut", root).value);
  setDevices(settings.get("inputId"), settings.get("outputId"));
  toast("Dispositivos atualizados");
}

function renderCal() {
  const cal = settings.get("cal"), st = $("#sCalStatus", root);
  if (!cal) { setStatus(st, "Nenhum arquivo carregado."); return; }
  const p = cal.points;
  setStatus(st, `${settings.get("calName")}: ${p.length} pontos de ${fmt(p[0][0], 0)} a ${fmt(p.at(-1)[0], 0)} Hz${cal.sens != null ? ` · Sens Factor ${fmt(cal.sens, 2)} dB` : ""}.`, "ok");
}

async function importCal(file) {
  try {
    const cal = d.parseCal(await file.text());
    settings.set("calName", file.name);
    settings.set("cal", cal);
    renderCal();
    toast("Calibração aplicada");
  } catch (e) {
    setStatus($("#sCalStatus", root), e.message, "err");
  }
}

async function calibrateSpl() {
  const ref = parseFloat($("#sRef", root).value), st = $("#sSplStatus", root), w = $("#sW", root).value;
  if (!Number.isFinite(ref)) { setStatus(st, "Digite a leitura do decibelímetro de referência.", "err"); return; }
  let sum = 0, n = 0, unsub;
  try {
    setStatus(st, "Medindo 3 s…");
    unsub = await live.subscribe(b => {
      const { P, df } = d.powerSpectrum(b, live.sampleRate);
      sum += 10 ** (d.overallLevel(P, df, w) / 10); n++;
    });
    await sleep(3000);
  } catch (e) { setStatus(st, e.message, "err"); return; } finally { unsub?.(); }
  if (!n) { setStatus(st, "Nenhum áudio recebido do microfone.", "err"); return; }
  const dbfs = d.db10(sum / n), off = ref - dbfs;
  settings.set("weight", w);
  settings.set("splOffset", off);
  settings.set("splCalibrated", true);
  $("#sOff", root).value = off.toFixed(1);
  setStatus(st, `Calibrado: ${fmt(dbfs, 1)} dBFS(${w}) = ${fmt(ref, 1)} dB(${w}). Deslocamento ${fmt(off, 1)} dB.`, "ok");
}

function renderPink() {
  const on = gen.playing && gen.params?.wave === "pink";
  $("#sPink", root).textContent = on ? "Parar ruído rosa" : "Tocar ruído rosa";
}

export default {
  id: "ajustes", title: "Ajustes", icon: "settings", tab: false,
  mount(el) {
    root = el;
    root.innerHTML = TEMPLATE;
    renderDevices();
    $("#sRefresh", root).onclick = renderDevices;
    $("#sIn", root).onchange = applyDevices;
    $("#sOut", root).onchange = applyDevices;
    $("#sCalFile", root).onchange = e => e.target.files[0] && importCal(e.target.files[0]);
    $("#sCalClear", root).onclick = () => { settings.set("cal", null); settings.set("calName", ""); renderCal(); };
    $("#sW", root).value = settings.get("weight");
    $("#sOff", root).value = settings.get("splOffset").toFixed(1);
    $("#sOff", root).onchange = e => { settings.set("splOffset", parseFloat(e.target.value) || 0); settings.set("splCalibrated", true); };
    $("#sCal", root).onclick = calibrateSpl;
    $("#sCalReset", root).onclick = () => { settings.set("splOffset", 0); settings.set("splCalibrated", false); $("#sOff", root).value = "0.0"; setStatus($("#sSplStatus", root), "Leituras voltaram a dBFS."); };
    $("#sPink", root).onclick = () => {
      if (gen.playing && gen.params?.wave === "pink") gen.stop();
      else gen.play({ wave: "pink", f: 1000, level: settings.get("genLevel") / 100, wobble: 0 });
      setTimeout(renderPink, 50);
    };
    $("#sA4", root).value = settings.get("a4");
    $("#sA4", root).onchange = e => settings.set("a4", parseFloat(e.target.value) || 440);
    const temp = () => { $("#sC", root).textContent = `Velocidade do som: ${fmt(d.speedOfSound(settings.get("temp")), 1)} m/s (usada nos modos da sala).`; };
    $("#sTemp", root).value = settings.get("temp");
    $("#sTemp", root).onchange = e => { settings.set("temp", parseFloat(e.target.value) || 22); temp(); };
    temp();
    $("#sWipe", root).onclick = async e => {
      const b = e.currentTarget;
      if (!b.dataset.confirm) {
        b.dataset.confirm = "1"; b.textContent = "Tocar de novo para apagar tudo";
        setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = "Apagar todo o histórico"; } }, 4000);
        return;
      }
      await store.clear();
      settings.set("refId", null);
      delete b.dataset.confirm; b.textContent = "Apagar todo o histórico";
      setStatus($("#sWipeStatus", root), "Histórico apagado.", "ok");
      emit("history-changed");
    };
    const i = app.info;
    $("#sAbout", root).textContent = `Sweep Meter ${i.version || ""} · ${fmt(i.sampleRate / 1000, 1)} kHz · entrada ${i.source || "—"}.`;
    setDevices(settings.get("inputId"), settings.get("outputId"));
    renderCal(); renderPink();
  },
  show() { renderDevices(); renderPink(); },
  hide() {},
};
