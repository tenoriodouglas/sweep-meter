// Shared UI helpers, settings and app-wide state.
import { noteOf } from "./dsp.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Next animation frame, so "Calculating…" states paint before heavy work. */
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

/** Number in pt-BR with fixed decimals; "—" for non-finite. */
export const fmt = (v, d = 1) => Number.isFinite(v)
  ? v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })
  : "—";

export const fmtHz = f => !Number.isFinite(f) ? "—"
  : f >= 1000 ? `${fmt(f / 1000, f >= 10000 ? 1 : 2)} kHz` : `${fmt(f, f < 100 ? 1 : 0)} Hz`;

export const fmtSigned = (v, d = 1) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);

export function noteLabel(f) {
  const n = noteOf(f, settings.get("a4"));
  return n ? `${n.name}${n.octave} ${fmtSigned(n.cents, 0)}¢` : "";
}

export const fmtDate = ts => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/* ---------- Event bus ---------- */
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, e => fn(e.detail));

/* ---------- Settings (per device, browser storage) ---------- */
const DEFAULTS = {
  f1: 30, f2: 16000, dur: 6, level: 70, reps: 1, win: 0.5, smooth: 12, pLo: 30, pHi: 500, normalize: true,
  roomL: 4.2, roomW: 3.1, roomH: 2.6, roomExample: true, temp: 22, a4: 440,
  splOffset: 0, splCalibrated: false, weight: "A",
  inputId: 0, outputId: 0, cal: null, calName: "", refId: null,
  genWave: "sine", genFreq: 100, genLevel: 50, genWobble: 0, genStep: 1,
};
const KEY = "sweepmeter.settings.v2";
let stored = {};
try { stored = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { stored = {}; }

export const settings = {
  get: k => (k in stored ? stored[k] : DEFAULTS[k]),
  set(k, v) {
    stored[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* storage unavailable */ }
    emit("settings", { key: k, value: v });
  },
};

/* ---------- App state ---------- */
export const app = {
  info: { sampleRate: 48000, source: "", version: "" },
  current: null,      // measurement shown in Medir
  glass: null,        // last tap analysis
};

/* ---------- Toast ---------- */
let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

export function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

/** Wires a .seg container: buttons with data-v; returns a setter. */
export function segmented(root, onChange, initial) {
  const buttons = $$("button", root);
  const set = v => buttons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));
  buttons.forEach(b => b.addEventListener("click", () => { set(b.dataset.v); onChange(b.dataset.v); }));
  if (initial !== undefined) set(initial);
  return set;
}

/** Copies text; falls back to a selectable prompt-free toast when the clipboard is refused. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copiado"); return true; } catch { toast("Não foi possível copiar"); return false; }
}

/** Inline SVG icons (stroke-based, 24px grid). */
export const ICONS = {
  measure: '<svg viewBox="0 0 24 24"><path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-6 6-6"/></svg>',
  live: '<svg viewBox="0 0 24 24"><path d="M5 20V12M9.5 20V6M14 20v-9M18.5 20V9"/></svg>',
  generator: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6.5 12c1.4-3.5 2.8-3.5 4.2 0s2.8 3.5 4.2 0 1.4-1.8 2.6-1.8"/></svg>',
  glass: '<svg viewBox="0 0 24 24"><path d="M7 3h10c0 5-1.5 9-5 9S7 8 7 3zM12 12v8M8 21h8"/></svg>',
  room: '<svg viewBox="0 0 24 24"><path d="M3 9l9-6 9 6v11H3z"/><path d="M8 20v-6h8v6"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
};
