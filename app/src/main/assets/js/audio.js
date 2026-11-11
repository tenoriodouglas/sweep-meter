// Audio I/O: Android bridge (window.Native) with a Web Audio fallback for browsers.
import { pinkNoise } from "./dsp.js";
import { emit } from "./ui.js";

export const NATIVE = window.Native || null;
export const PRE_ROLL = 0.4; // silence before the sweep (s)
export const TAIL = 2.5;     // capture after the sweep for the decay (s)
const BLOCK = 2048;

/* ---------- Web Audio context ---------- */
let ctx = null, workletReady = false;
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("capture", Capture);`;

async function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  await ctx.resume();
  if (!workletReady) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    workletReady = true;
  }
  return ctx;
}

async function micStream() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microfone indisponível. Abra o app por HTTPS ou instale o APK.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
}

/* ---------- Device info ---------- */
export function info() {
  if (NATIVE) return JSON.parse(NATIVE.info());
  return { sampleRate: ctx?.sampleRate || 48000, source: "Navegador", version: "web" };
}

export function devices() {
  if (NATIVE) return JSON.parse(NATIVE.devices());
  return { inputs: [], outputs: [], inputId: 0, outputId: 0 };
}

export function setDevices(inputId, outputId) {
  NATIVE?.setDevices(inputId | 0, outputId | 0);
}

const permissionError = () => Object.assign(new Error("Permita o uso do microfone e tente de novo."), { name: "NotAllowedError" });

/* ---------- One-shot captures (sweep measurement, tap listening) ---------- */

function nativeCapture(start, onTick) {
  return new Promise((resolve, reject) => {
    window.onNativeProgress = (frac, levelDb) => onTick?.(frac, levelDb);
    window.onNativeError = msg => reject(new Error(msg));
    window.onNativeDone = async () => {
      try {
        const r = await fetch("/rec/latest?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) throw new Error("Gravação indisponível (" + r.status + ")");
        resolve(new Float32Array(await r.arrayBuffer()));
      } catch (e) { reject(e); }
    };
    const status = start();
    if (status === "permission") reject(permissionError());
    else if (status !== "ok") reject(new Error("Já existe uma captura em andamento."));
  });
}

async function webCaptureRun(c, stream, signal, level, onTick) {
  const sr = c.sampleRate, src = c.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(c, "capture", { channelCount: 1, channelCountMode: "explicit" });
  const sink = c.createGain(); sink.gain.value = 0;
  const chunks = []; let rms = 0;
  node.port.onmessage = e => {
    const x = e.data; chunks.push(x);
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    rms = Math.sqrt(s / x.length);
  };
  src.connect(node); node.connect(sink); sink.connect(c.destination);
  const buf = c.createBuffer(1, Math.max(1, signal.length), sr); buf.copyToChannel(signal, 0);
  const player = c.createBufferSource(); player.buffer = buf;
  const gain = c.createGain(); gain.gain.value = level;
  player.connect(gain); gain.connect(c.destination);
  const t0 = c.currentTime, total = PRE_ROLL + signal.length / sr + TAIL;
  player.start(t0 + PRE_ROLL);
  await new Promise(res => {
    const id = setInterval(() => {
      const el = c.currentTime - t0;
      onTick?.(Math.min(1, el / total), 20 * Math.log10(rms + 1e-12));
      if (el >= total) { clearInterval(id); res(); }
    }, 50);
  });
  src.disconnect(); node.disconnect(); sink.disconnect(); gain.disconnect();
  const out = new Float32Array(chunks.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const x of chunks) { out.set(x, o); o += x.length; }
  return out;
}

/** Opens a capture session: sweep measurement and record-only listening. */
export async function openSession() {
  if (NATIVE) {
    const i = info();
    return {
      sampleRate: i.sampleRate, source: i.source,
      capture: (p, _sweep, onTick) => nativeCapture(() => NATIVE.measure(JSON.stringify({ ...p, preRoll: PRE_ROLL, tail: TAIL })), onTick),
      listen: (sec, onTick) => nativeCapture(() => NATIVE.listen(sec), onTick),
      close() {},
    };
  }
  const c = await audioCtx(), stream = await micStream();
  return {
    sampleRate: c.sampleRate, source: "Navegador",
    capture: (p, sweep, onTick) => webCaptureRun(c, stream, sweep, p.level, onTick),
    listen: (sec, onTick) => webCaptureRun(c, stream, new Float32Array(Math.round(sec * c.sampleRate)), 0, onTick),
    close: () => stream.getTracks().forEach(t => t.stop()),
  };
}

/* ---------- Live input stream ---------- */

function decodeFloat32(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export const live = {
  running: false,
  sampleRate: 48000,
  _web: null,
  _starting: null,
  _subs: new Set(),

  /** Subscribes to 2048-sample blocks; starts the stream on the first subscriber. */
  async subscribe(onBlock) {
    this._subs.add(onBlock);
    if (!this.running) {
      this._starting ??= this._start().finally(() => { this._starting = null; });
      await this._starting;
    }
    return () => this.unsubscribe(onBlock);
  },

  unsubscribe(onBlock) {
    this._subs.delete(onBlock);
    if (!this._subs.size) this._stop();
  },

  _deliver(block) { for (const fn of this._subs) fn(block); },

  async _start() {
    if (NATIVE) {
      this.sampleRate = info().sampleRate;
      window.onLiveData = b64 => this._deliver(decodeFloat32(b64));
      window.onLiveError = msg => { this._halt(); emit("live-error", msg); };
      const status = NATIVE.liveStart();
      if (status === "permission") { this._subs.clear(); throw permissionError(); }
      if (status !== "ok") { this._subs.clear(); throw new Error("Microfone ocupado por uma medição."); }
    } else {
      const c = await audioCtx(), stream = await micStream();
      this.sampleRate = c.sampleRate;
      const src = c.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(c, "capture", { channelCount: 1, channelCountMode: "explicit" });
      const sink = c.createGain(); sink.gain.value = 0;
      let acc = new Float32Array(BLOCK), fill = 0;
      node.port.onmessage = e => {
        const x = e.data;
        for (let i = 0; i < x.length; i++) {
          acc[fill++] = x[i];
          if (fill === BLOCK) { this._deliver(acc); acc = new Float32Array(BLOCK); fill = 0; }
        }
      };
      src.connect(node); node.connect(sink); sink.connect(c.destination);
      this._web = { stream, src, node, sink };
    }
    this.running = true;
    emit("live", { running: true });
  },

  _stop() {
    if (!this.running) return;
    if (NATIVE) NATIVE.liveStop();
    this._halt();
  },

  _halt() {
    if (this._web) {
      const w = this._web;
      w.src.disconnect(); w.node.disconnect(); w.sink.disconnect();
      w.stream.getTracks().forEach(t => t.stop());
      this._web = null;
    }
    this._subs.clear();
    this.running = false;
    emit("live", { running: false });
  },
};

/* ---------- Signal generator ---------- */

const WOBBLE_PERIOD = 8; // s, matches SignalGenerator.kt

export const gen = {
  playing: false,
  params: null,
  _web: null,

  /** p: { wave, f, level (0–1), wobble (fraction) }. Retunes if already playing. */
  async play(p) {
    this.params = { ...p };
    if (NATIVE) NATIVE.genPlay(p.wave, p.f, p.level, p.wobble || 0);
    else await this._webPlay(p);
    this.playing = true;
    emit("gen", { playing: true, params: this.params });
  },

  stop() {
    if (!this.playing) return;
    if (NATIVE) NATIVE.genStop();
    else this._webStop();
    this.playing = false;
    emit("gen", { playing: false, params: this.params });
  },

  async _webPlay(p) {
    const c = await audioCtx(), t = c.currentTime, noise = p.wave === "white" || p.wave === "pink";
    if (this._web && this._web.noise !== noise) this._webStop();
    if (!this._web) {
      const out = c.createGain(); out.gain.value = 0; out.connect(c.destination);
      let src, lfo = null, depth = null;
      if (noise) {
        const n = c.sampleRate * 4, buf = c.createBuffer(1, n, c.sampleRate);
        buf.copyToChannel(p.wave === "pink" ? pinkNoise(n) : Float32Array.from({ length: n }, () => Math.random() * 2 - 1), 0);
        src = c.createBufferSource(); src.buffer = buf; src.loop = true;
      } else {
        src = c.createOscillator();
        lfo = c.createOscillator(); depth = c.createGain();
        lfo.frequency.value = 1 / WOBBLE_PERIOD; lfo.connect(depth); depth.connect(src.frequency); lfo.start();
      }
      src.connect(out); src.start();
      this._web = { src, out, lfo, depth, noise, wave: p.wave };
    }
    const w = this._web;
    if (!noise) {
      w.src.type = p.wave === "sawtooth" ? "sawtooth" : p.wave;
      w.src.frequency.setTargetAtTime(p.f, t, 0.03);
      w.depth.gain.setTargetAtTime(p.f * (p.wobble || 0), t, 0.03);
    } else if (w.wave !== p.wave) {
      this._webStop();
      return this._webPlay(p);
    }
    w.out.gain.setTargetAtTime(p.level, t, 0.03);
  },

  _webStop() {
    const w = this._web;
    if (!w) return;
    this._web = null;
    w.out.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    setTimeout(() => { w.src.stop(); w.lfo?.stop(); w.out.disconnect(); }, 300);
  },
};

/* App moved to background: native side already stopped everything. */
window.onNativeStopped = () => {
  if (gen.playing) { gen.playing = false; emit("gen", { playing: false, params: gen.params }); }
  if (live.running) live._halt();
};
window.onLiveStopped = () => live._halt();

/* ---------- Sharing ---------- */

function toBase64(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Shares (app) or downloads (browser) a text or binary file. */
export function shareFile(name, mime, data) {
  if (NATIVE) { NATIVE.shareFile(name, mime, toBase64(data)); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
