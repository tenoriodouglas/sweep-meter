// App shell: hash router, bottom tabs, app bar and the global generator pill.
import { info, gen, setDevices } from "./audio.js";
import { $, app, on, settings, fmt, ICONS } from "./ui.js";
import measure from "./views/measure.js";
import liveView from "./views/live.js";
import generator from "./views/generator.js";
import glass from "./views/glass.js";
import room from "./views/room.js";
import historyView from "./views/history.js";
import settingsView from "./views/settings.js";

const VIEWS = [measure, liveView, generator, glass, room, historyView, settingsView];
const DEFAULT = "medir";
let current = null;

function buildShell() {
  const tabs = $("#tabs"), main = $("#views");
  for (const v of VIEWS) {
    const sec = document.createElement("section");
    sec.className = "view"; sec.id = "view-" + v.id; sec.hidden = true;
    sec.setAttribute("aria-label", v.title);
    main.appendChild(sec);
    if (v.tab) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tab"; b.dataset.view = v.id;
      b.innerHTML = `${ICONS[v.icon]}<span>${v.title}</span>`;
      b.onclick = () => { location.hash = "#" + v.id; };
      tabs.appendChild(b);
    }
  }
  $("#btnHistory").innerHTML = ICONS.history;
  $("#btnSettings").innerHTML = ICONS.settings;
  $("#btnBack").innerHTML = ICONS.back;
  $("#btnHistory").onclick = () => { location.hash = "#historico"; };
  $("#btnSettings").onclick = () => { location.hash = "#ajustes"; };
  $("#btnBack").onclick = () => (window.history.length > 1 ? window.history.back() : (location.hash = "#" + DEFAULT));
  $("#genPill").onclick = () => gen.stop();
}

function route() {
  const id = location.hash.slice(1) || DEFAULT, view = VIEWS.find(v => v.id === id) || measure;
  if (current === view) return;
  current?.hide();
  for (const v of VIEWS) {
    const el = $("#view-" + v.id);
    el.hidden = v !== view;
    if (v === view) { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); }
  }
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-current", t.dataset.view === view.id ? "page" : "false"));
  $("#btnHistory").setAttribute("aria-current", view.id === "historico" ? "page" : "false");
  $("#btnSettings").setAttribute("aria-current", view.id === "ajustes" ? "page" : "false");
  $("#btnBack").hidden = view.tab;
  $("#viewTitle").textContent = view.tab ? "Sweep Meter" : view.title;
  $("#views").scrollTop = 0;
  current = view;
  view.show();
}

const WAVE_NAMES = { sine: "", square: "□ ", triangle: "△ ", sawtooth: "⟋ ", white: "ruído branco", pink: "ruído rosa" };

function renderPill({ playing, params }) {
  const pill = $("#genPill");
  pill.hidden = !playing;
  if (!playing || !params) return;
  const noise = params.wave === "white" || params.wave === "pink";
  $("#genPillText").textContent = noise ? WAVE_NAMES[params.wave] : `${WAVE_NAMES[params.wave]}${fmt(params.f, params.f < 1000 ? 1 : 0)} Hz`;
  pill.setAttribute("aria-label", "Parar gerador");
}

async function init() {
  try { app.info = info(); } catch { /* browser before audio unlock */ }
  setDevices(settings.get("inputId"), settings.get("outputId"));
  buildShell();
  on("gen", renderPill);
  for (const v of VIEWS) await v.mount($("#view-" + v.id));
  window.addEventListener("hashchange", route);
  route();
}

init();
