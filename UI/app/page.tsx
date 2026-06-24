"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Space_Grotesk } from "next/font/google";

const display = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });

const DownloadIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
  </svg>
);

const BASE = process.env.NEXT_PUBLIC_API_URL!;

type UploadResult = { key: string; filename: string; cached: boolean; bytes: number };
type SeparateResult = { format: string; cached: boolean; stems: Record<string, string> };
type LoadedStem = { name: string; peaks: number[]; blob: Blob }; // blob kept for later playback/download
type LoadedSong = { key: string; filename: string; duration: number; stems: LoadedStem[] };

async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return res.json();
}

// sends the KEY as JSON, not a file as FormData
async function separateByKey(key: string): Promise<SeparateResult> {
  const res = await fetch(`${BASE}/separate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`separate ${res.status}: ${await res.text()}`);
  return res.json();
}

// base64 text → raw bytes (each char code IS a byte)
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// one AudioContext, reused only to DECODE (we never play through it here)
let _decodeCtx: AudioContext | null = null;
function getDecodeCtx(): AudioContext {
  if (!_decodeCtx) _decodeCtx = new AudioContext();
  return _decodeCtx;
}

// downsample a decoded buffer into n peak values (the waveform envelope)
function rawPeaks(buffer: AudioBuffer, n = 600): number[] {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / n));
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    let max = 0;
    const start = i * block;
    for (let j = 0; j < block; j++) {
      const v = Math.abs(data[start + j] || 0);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

// max across stems per column → one overview waveform for the whole song
function combinePeaks(stems: LoadedStem[], n = 600): number[] {
  const out = new Array(n).fill(0);
  for (const s of stems) for (let i = 0; i < n; i++) if ((s.peaks[i] || 0) > out[i]) out[i] = s.peaks[i];
  return out;
}

function Dropzone({ onFile, busy, label = "Uploading…" }: { onFile: (file: File) => void; busy: boolean; label?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) return;
    onFile(file);
  };
  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { e.preventDefault(); if (--depth.current <= 0) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0; setOver(false);
        accept(e.dataTransfer.files[0]);
      }}
      onClick={() => inputRef.current?.click()}
      className={`mx-auto mt-5 flex h-16 max-w-6xl cursor-pointer items-center justify-center border border-dashed text-sm transition-colors ${
        over ? "border-white/60 bg-white/[0.04] text-white/80" : "border-white/20 text-white/40 hover:border-white/40"
      }`}
    >
      {busy ? label : over ? "Release to upload" : "Drop an audio file to separate"}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => { accept(e.target.files?.[0]); e.target.value = ""; }}
      />
    </div>
  );
}

function SplitText({ children, className = "", idle = false }: { children: string; className?: string; idle?: boolean }) {
  const base = `relative inline-block cursor-[inherit] transition-colors duration-500 ease-out
    before:pointer-events-none before:absolute before:inset-0 before:text-red-500 before:content-[attr(data-text)]
    after:pointer-events-none after:absolute after:inset-0 after:text-blue-500 after:content-[attr(data-text)]`;
  const glitchMode = `animate-[glitchBase_4.5s_linear_infinite] motion-reduce:animate-none
    before:animate-[glitchRed_4.5s_linear_infinite] motion-reduce:before:animate-none motion-reduce:before:opacity-0
    after:animate-[glitchBlue_4.5s_linear_infinite] motion-reduce:after:animate-none motion-reduce:after:opacity-0`;
  return <span data-text={children} className={`${base} ${idle ? glitchMode : "before:opacity-0 after:opacity-0"} ${className}`}>{children}</span>;
}

function Knob({ value, min, max, step = 1, onChange, label, format }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; format: (v: number) => string;
}) {
  const [grabbing, setGrabbing] = useState(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const snap = (v: number) => Math.round(v / step) * step;
  const angle = -135 + ((value - min) / (max - min)) * 270;
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault(); setGrabbing(true);
    const startY = e.clientY, startVal = value;
    const move = (ev: PointerEvent) => onChange(clamp(snap(startVal + ((startY - ev.clientY) / 150) * (max - min))));
    const up = () => { setGrabbing(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className="flex select-none flex-col items-center gap-1">
      <div onPointerDown={startDrag} onWheel={(e) => onChange(clamp(snap(value - Math.sign(e.deltaY) * step)))}
        role="slider" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
        className={`relative h-16 w-16 cursor-ns-resize rounded-full border bg-white/[0.05] transition-transform duration-150 ${grabbing ? "scale-95 border-white/60" : "border-white/20 hover:border-white/40"}`}>
        <div className="absolute inset-0 transition-transform duration-100" style={{ transform: `rotate(${angle}deg)` }}>
          <div className="absolute left-1/2 top-1.5 h-3 w-0.5 -translate-x-1/2 rounded bg-white/80" />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-medium text-white/90">{format(value)}</span>
        </div>
      </div>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(clamp(snap(parseFloat(e.target.value) || 0)))}
        className="w-14 bg-transparent text-center text-[11px] text-white/60 outline-none [appearance:textfield]" />
      <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</span>
    </div>
  );
}

const LANE_H = 56, RULER_H = 28, HEADER_W = 300;
const A432_MAG = 31.77;
const clampN = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
function makePeaks(seed: string, n = 600) {
  let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);
  return Array.from({ length: n }, (_, i) => {
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / n) * Math.PI * 4));
    return Math.max(0.04, env * (0.3 + 0.7 * rand()));
  });
}
function wavePath(p: number[]) {
  let d = "M 0 50";
  for (let i = 0; i < p.length; i++) d += ` L ${i} ${50 - p[i] * 47}`;
  for (let i = p.length - 1; i >= 0; i--) d += ` L ${i} ${50 + p[i] * 47}`;
  return d + " Z";
}
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
const niceStep = (px: number) => [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((x) => x >= 72 / px) ?? 60;

type Channel = { volume: number; muted: boolean; solo: boolean };

function Waveform({ peaks, muted, accent, empty = false }: { peaks: number[]; muted: boolean; accent: string; empty?: boolean }) {
  const d = useMemo(() => wavePath(peaks), [peaks]);
  if (empty) {
    return (
      <svg viewBox="0 0 600 100" preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" y1="50" x2="600" y2="50" stroke={accent} strokeOpacity="0.18" strokeWidth="0.8" strokeDasharray="6 5" />
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" className="h-full w-full">
      <path d={d} style={{ fill: accent, fillOpacity: muted ? 0.1 : 0.5, transition: "fill-opacity 700ms ease, fill 700ms ease" }} />
    </svg>
  );
}

function TrackHeader({ label, ch, onVol, onMute, onSolo, onDownload }: {
  label: string; ch: Channel; onVol: (v: number) => void; onMute: () => void; onSolo: () => void; onDownload: () => void;
}) {
  const btn = "h-6 w-6 shrink-0 rounded text-[10px] font-bold uppercase transition active:scale-90";
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-3" style={{ height: LANE_H }}>
      <button onClick={onSolo} className={`${btn} ${ch.solo ? "bg-yellow-400 text-black" : "bg-white/5 text-white/40 hover:text-white"}`}>S</button>
      <button onClick={onMute} className={`${btn} ${ch.muted ? "bg-red-500 text-white" : "bg-white/5 text-white/40 hover:text-white"}`}>M</button>
      <span className="flex-1 truncate text-xs">{label}</span>
      <input type="range" min={0} max={1} step={0.01} value={ch.volume} onChange={(e) => onVol(parseFloat(e.target.value))} className="w-14 accent-white" />
      <button onClick={onDownload} title={`Download ${label}`} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/40 transition active:scale-90 hover:bg-white/10 hover:text-white">
        <DownloadIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Ruler({ duration, pxPerSec }: { duration: number; pxPerSec: number }) {
  const step = niceStep(pxPerSec); const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return (
    <div className="relative border-b border-white/10" style={{ height: RULER_H }}>
      {ticks.map((t) => (
        <div key={t} className="absolute bottom-0 flex flex-col items-start" style={{ left: `${(t / duration) * 100}%` }}>
          <span className="mb-0.5 ml-1 text-[9px] tabular-nums text-white/40">{fmtTime(t)}</span>
          <div className="h-2 w-px bg-white/25" />
        </div>
      ))}
    </div>
  );
}

function LoopRegion({ start, end, duration, enabled, laneRef, height, onChange }: {
  start: number; end: number; duration: number; enabled: boolean;
  laneRef: React.RefObject<HTMLDivElement | null>; height: number; onChange: (s: number, e: number) => void;
}) {
  const drag = (mode: "move" | "l" | "r") => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    const rect = laneRef.current!.getBoundingClientRect();
    const x0 = ev.clientX, s0 = start, e0 = end, minLen = 0.2;
    const move = (e: PointerEvent) => {
      const dt = ((e.clientX - x0) / rect.width) * duration; let ns = s0, ne = e0;
      if (mode === "move") { ns = s0 + dt; ne = e0 + dt; if (ns < 0) { ne -= ns; ns = 0; } if (ne > duration) { ns -= ne - duration; ne = duration; } }
      else if (mode === "l") ns = clampN(s0 + dt, 0, e0 - minLen); else ne = clampN(e0 + dt, s0 + minLen, duration);
      onChange(ns, ne);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className="absolute top-0 z-20 transition-[left,width] duration-150" style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%`, height }}>
      <div onPointerDown={drag("move")} className={`relative h-full cursor-grab border-x active:cursor-grabbing ${enabled ? "animate-[loopPulse_2.4s_ease-in-out_infinite]" : "border-yellow-400/30 bg-yellow-400/[0.04] opacity-60"}`}>
        <span className="absolute -top-4 left-0 text-[9px] uppercase tracking-[0.25em] text-yellow-400/90">Loop</span>
        <div onPointerDown={drag("l")} className="absolute left-0 top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize" />
        <div onPointerDown={drag("r")} className="absolute right-0 top-0 h-full w-2 translate-x-1/2 cursor-ew-resize" />
        <div className="pointer-events-none absolute left-0 top-0 h-2 w-2 border-l border-t border-yellow-400" />
        <div className="pointer-events-none absolute right-0 top-0 h-2 w-2 border-r border-t border-yellow-400" />
        <div className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-b border-l border-yellow-400" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 border-b border-r border-yellow-400" />
      </div>
    </div>
  );
}

function Playhead({ time, duration, height }: { time: number; duration: number; height: number }) {
  return (
    <div className="pointer-events-none absolute top-0 z-30 transition-[left] duration-100" style={{ left: `${(time / duration) * 100}%`, height }}>
      <div className="h-full w-px bg-white/90" />
      <div className="absolute -left-[3px] -top-1 h-2 w-2 rotate-45 bg-white/90" />
    </div>
  );
}

// dropzone's replacement once a song is loaded: name + overview waveform + clear
function LoadedBar({ song, onClear }: { song: LoadedSong; onClear: () => void }) {
  const overview = useMemo(() => combinePeaks(song.stems), [song]);
  return (
    <div className="mx-auto mt-5 flex max-w-6xl items-center gap-4 border border-white/30 bg-black/30 px-4 py-3">
      <div className="min-w-0 shrink-0 sm:w-48">
        <div className="truncate text-sm text-white/90">{song.filename}</div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-white/40">
          {fmtTime(song.duration)} · {song.stems.length} stems loaded
        </div>
      </div>
      <div className="h-10 flex-1">
        <Waveform peaks={overview} muted={false} accent="rgba(255,255,255,0.85)" />
      </div>
      <button onClick={onClear}
        className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-white/40 transition active:scale-95 hover:text-white/90">
        ✕ Clear
      </button>
    </div>
  );
}

type Model = {
  id: string; label: string; image: string; accent: string; kind: string;
  stems: { id: string; label: string }[];
  vocalSplit?: boolean;
  underDevelopment?: boolean;
  subModels?: { id: string; label: string }[];
};
const MODELS: Model[] = [
  { id: "htdemucs", label: "Music Source Separator", image: "/2.jpg", accent: "#f07bb7", kind: "Music · 4-stem",
    stems: [{ id: "vocals", label: "Vocals" }, { id: "drums", label: "Drums" }, { id: "bass", label: "Bass" }, { id: "other", label: "Other" }],
    subModels: [{ id: "htdemucs_ft", label: "Mucus" }, { id: "htdemucs_v3", label: "Mode 2" }] },
  { id: "cdx", label: "Score / Dialogue / FX", image: "/1.jpg", accent: "#29ccb6", kind: "Cinematic · CDX",
    stems: [{ id: "dialogue", label: "Dialogue" }, { id: "music", label: "Music" }, { id: "effects", label: "Effects" }],
    underDevelopment: true },
  { id: "vocal", label: "Vocal Isolation", image: "/3.jpg", accent: "#8590f6", kind: "Voice · Isolation", vocalSplit: true,
    stems: [{ id: "vocals", label: "Vocals" }, { id: "accompaniment", label: "Accompaniment" }],
    underDevelopment: true },
];

function Studio({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<"idle" | "uploading" | "separating" | "done" | "error">("idle");
  const [loaded, setLoaded] = useState<LoadedSong | null>(null);

  const [modelId, setModelId] = useState(MODELS[0].id);
  const model = MODELS.find((m) => m.id === modelId)!;
  const [subModelId, setSubModelId] = useState(MODELS[0].subModels![0].id);;

  const [mix, setMix] = useState<Record<string, Channel>>({});
  useEffect(() => {
    const init: Record<string, Channel> = {};
    model.stems.forEach((s) => (init[s.id] = { volume: 0.8, muted: false, solo: false }));
    setMix(init);
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const peaks = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const s of model.stems) {
      const hit = loaded?.stems.find((ls) => ls.name === s.id); // htdemucs ids == backend stem names
      out[s.id] = hit ? hit.peaks : makePeaks(s.id);            // real if loaded, else placeholder
    }
    return out;
  }, [modelId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const setVol = (id: string, v: number) => setMix((m) => ({ ...m, [id]: { ...m[id], volume: v } }));
  const toggleMute = (id: string) => setMix((m) => ({ ...m, [id]: { ...m[id], muted: !m[id].muted } }));
  const toggleSolo = (id: string) => setMix((m) => ({ ...m, [id]: { ...m[id], solo: !m[id].solo } }));

  const downloadStem = (stemId: string, label: string) => {
    if (!loaded) return;
    const stem = loaded.stems.find((s) => s.name === stemId);
    if (!stem) return;
    const url = URL.createObjectURL(stem.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${loaded.filename.replace(/\.[^.]+$/, "")}_${label}.mp3`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [playing, setPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [master, setMaster] = useState(0.9);
  const [speed, setSpeed] = useState(1);
  const [transpose, setTranspose] = useState(0);
  const [cents, setCents] = useState(0);
  const [a432dir, setA432dir] = useState(0);

  const tuningCents = cents + a432dir * A432_MAG;
  const refHz = 440 * Math.pow(2, tuningCents / 1200);

  const duration = loaded?.duration ?? 184;
  const [pxPerSec, setPxPerSec] = useState(9);
  const [loopStart, setLoopStart] = useState(16);
  const [loopEnd, setLoopEnd] = useState(40);
  const [playhead, setPlayhead] = useState(8);

  async function handleFile(file: File) {
    try {
      setStatus("uploading");
      const { key, filename } = await uploadFile(file);

      setStatus("separating");
      const { stems } = await separateByKey(key); // { name: base64 }

      // decode each stem JUST to draw it — nothing plays
      const ctx = getDecodeCtx();
      const decoded = await Promise.all(
        Object.entries(stems).map(async ([name, b64]) => {
          const bytes = base64ToBytes(b64);
          const blob = new Blob([bytes], { type: "audio/mpeg" }); // copy first (kept for later)
          const buffer = await ctx.decodeAudioData(bytes.buffer);  // detaches bytes; blob unaffected
          return { name, blob, raw: rawPeaks(buffer), dur: buffer.duration };
        })
      );

      // normalize all stems against one shared peak so quiet/loud stems stay relative
      const globalMax = Math.max(...decoded.flatMap((d) => d.raw), 0.0001);
      const stemsOut: LoadedStem[] = decoded.map((d) => ({
        name: d.name,
        blob: d.blob,
        peaks: d.raw.map((p) => Math.min(1, p / globalMax)),
      }));
      const dur = decoded[0]?.dur ?? 0;

      setLoaded({ key, filename, duration: dur, stems: stemsOut });
      setModelId("htdemucs"); // backend always returns the 4 htdemucs stems
      setPlayhead(0);         // fit the timeline cursors to the real song
      setLoopStart(0);
      setLoopEnd(Math.min(20, dur));
      setStatus("done");
    } catch (e) {
      console.error(e);
      setStatus("error");
    }
  }

  const laneRef = useRef<HTMLDivElement>(null);
  const zoom = (f: number) => setPxPerSec((p) => clampN(p * f, 3, 160));
  const onWheel = (e: React.WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.9); } };
  const seek = (e: React.PointerEvent) => {
    const rect = laneRef.current!.getBoundingClientRect();
    setPlayhead(clampN(((e.clientX - rect.left) / rect.width) * duration, 0, duration));
  };
  const lanesH = LANE_H * model.stems.length;

  return (
    <div style={{ "--accent": model.accent } as React.CSSProperties}>
      <div className="fixed inset-0 -z-10 bg-black/45" />

      <main className="relative z-10 min-h-screen animate-[studioIn_0.7s_ease-out] px-6 py-10 text-zinc-100">
        <style dangerouslySetInnerHTML={{ __html: `
          @property --rim-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
          @keyframes rimRotate { to { --rim-angle: 360deg; } }
          @keyframes loopPulse { 0%,100% { border-color: rgba(250,204,21,.5); background-color: rgba(250,204,21,.08);} 50% { border-color: rgba(250,204,21,.95); background-color: rgba(250,204,21,.16);} }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }` }} />

        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <button onClick={onBack} className="text-xs uppercase tracking-[0.25em] text-white/50 transition active:scale-95 hover:text-white/90">← Theseus</button>
          <span className="text-[10px] uppercase tracking-[0.3em] text-white/35">Audio // ML</span>
        </div>

        {loaded ? (
          <LoadedBar song={loaded} onClear={() => { setLoaded(null); setStatus("idle"); }} />
        ) : (
          <Dropzone
            onFile={handleFile}
            busy={status === "uploading" || status === "separating"}
            label={status === "separating" ? "Separating stems… (~50s)" : "Uploading…"}
          />
        )}
        {status === "error" && (
          <p className="mx-auto mt-2 max-w-6xl text-xs text-red-400/80">Something went wrong — check the console.</p>
        )}

        {/* STEM-MIX MODULE — content-sized, image as cropped backdrop */}
        <div className="relative mx-auto mt-5 max-w-6xl overflow-hidden border border-white/15">
          {MODELS.map((m) => (
            <div key={m.id} className="absolute inset-0 bg-cover bg-center transition-opacity duration-700 ease-out"
              style={{ backgroundImage: `url(${m.image})`, opacity: m.id === modelId ? 1 : 0 }} />
          ))}
          <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/45 to-black/72" />
          <div className="pointer-events-none absolute left-0 top-0 h-3 w-3 border-l border-t border-white/50" />
          <div className="pointer-events-none absolute right-0 top-0 h-3 w-3 border-r border-t border-white/50" />
          <div className="pointer-events-none absolute bottom-0 left-0 h-3 w-3 border-b border-l border-white/50" />
          <div className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b border-r border-white/50" />

          {model.underDevelopment && (
            <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-zinc-900/70 backdrop-blur-[2px]">
              <span className="text-[10px] uppercase tracking-[0.3em] text-white/40">Coming Soon</span>
            </div>
          )}

          {(status === "uploading" || status === "separating") && (
            <div
              className="pointer-events-none absolute inset-0 z-40"
              style={{
                padding: "1px",
                background: `conic-gradient(from var(--rim-angle), transparent 0%, transparent 55%, ${model.accent}22 65%, ${model.accent}99 78%, ${model.accent} 86%, #fff 89%, transparent 92%)`,
                WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                WebkitMaskComposite: "destination-out",
                maskComposite: "exclude",
                animation: "rimRotate 1.8s linear infinite",
              } as React.CSSProperties}
            />
          )}

          <div className="relative flex flex-col gap-7 p-8 md:p-10">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.3em] text-white/70">MODE</span>
                <span className="text-[10px] uppercase tracking-[0.25em] transition-colors duration-700" style={{ color: model.accent }}>{model.kind} · {model.stems.length} stems</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">{model.label}</h2>
                {model.subModels && (
                  <div className="group relative">
                    <div className="flex overflow-hidden border border-white/30">
                      {model.subModels.map((sm, i) => {
                        const on = sm.id === subModelId;
                        return (
                          <button key={sm.id} onClick={() => setSubModelId(sm.id)}
                            style={on ? { backgroundColor: model.accent } : undefined}
                            className={`px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-200 active:scale-95 ${on ? "text-black" : `text-white/50 hover:bg-white/10 hover:text-white ${i > 0 ? "border-l border-white/20" : ""}`}`}>
                            {sm.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="pointer-events-none absolute left-full top-1/2 ml-2.5 -translate-y-1/2 whitespace-nowrap border border-white/15 bg-black/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-white/60 opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
                      If one model doesn't perform well, try the other
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {MODELS.map((m) => {
                  const on = m.id === modelId;
                  return (
                    <div key={m.id} className="group relative">
                      <button onClick={() => setModelId(m.id)}
                        style={on ? { color: m.accent, borderColor: m.accent } : undefined}
                        className={`rounded-full border px-3 py-1 text-xs backdrop-blur-sm transition active:scale-95 ${on ? "bg-white/10" : "border-white/20 text-white/60 hover:text-white"}`}>
                        {m.label}
                      </button>
                      {m.underDevelopment && (
                        <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] uppercase tracking-[0.2em] text-white/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                          Under Development
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div key={modelId} className="animate-[fadeIn_0.35s_ease-out]">
              {model.vocalSplit ? (
                <div className="grid grid-cols-1 gap-3 border border-white/10 bg-black/25 p-3 backdrop-blur-[2px] md:grid-cols-2">
                  <div className="border border-white/10 p-4">
                    <h3 className="mb-3 text-[10px] uppercase tracking-[0.25em] text-white/60">Vocal Isolation / Denoising</h3>
                    {model.stems.map((s) => mix[s.id] && (
                      <TrackHeader key={s.id} label={s.label} ch={mix[s.id]} onVol={(v) => setVol(s.id, v)} onMute={() => toggleMute(s.id)} onSolo={() => toggleSolo(s.id)} onDownload={() => downloadStem(s.id, s.label)} />
                    ))}
                  </div>
                  <div className="flex flex-col border border-white/10 p-4">
                    <h3 className="mb-3 text-[10px] uppercase tracking-[0.25em] text-white/60">Voice Upsampling</h3>
                    <p className="mb-3 text-xs text-white/45">Bandwidth extension (→ 48 kHz). Backend inference pass on the isolated vocal.</p>
                    <button className="mt-auto border border-white/30 py-2 text-xs uppercase tracking-[0.25em] text-white/80 transition active:scale-95 hover:bg-white/10">Upsample →</button>
                  </div>
                </div>
              ) : (
                <div className="flex border border-white/10 bg-black/25 backdrop-blur-[2px]">
                  <div className="shrink-0 border-r border-white/10" style={{ width: HEADER_W }}>
                    <div className="flex items-center justify-between border-b border-white/10 px-3" style={{ height: RULER_H }}>
                      <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">Tracks</span>
                      <div className="flex gap-1">
                        <button onClick={() => zoom(0.8)} className="h-5 w-5 border border-white/15 text-xs text-white/60 transition active:scale-90 hover:text-white">−</button>
                        <button onClick={() => zoom(1.25)} className="h-5 w-5 border border-white/15 text-xs text-white/60 transition active:scale-90 hover:text-white">+</button>
                      </div>
                    </div>
                    {model.stems.map((s) => mix[s.id] && (
                      <TrackHeader key={s.id} label={s.label} ch={mix[s.id]} onVol={(v) => setVol(s.id, v)} onMute={() => toggleMute(s.id)} onSolo={() => toggleSolo(s.id)} onDownload={() => downloadStem(s.id, s.label)} />
                    ))}
                  </div>
                  <div onWheel={onWheel} className="relative flex-1 overflow-x-auto">
                    <div ref={laneRef} className="relative transition-[width] duration-200 ease-out" style={{ width: duration * pxPerSec }}>
                      <Ruler duration={duration} pxPerSec={pxPerSec} />
                      <div className="relative" onPointerDown={seek}>
                        {model.stems.map((s) => mix[s.id] && (
                          <div key={s.id} className="border-b border-white/10" style={{ height: LANE_H }}>
                            <Waveform peaks={peaks[s.id]} muted={mix[s.id].muted} accent={model.accent} empty={!loaded} />
                          </div>
                        ))}
                        <LoopRegion start={loopStart} end={loopEnd} duration={duration} enabled={loopEnabled} laneRef={laneRef} height={lanesH} onChange={(s, e) => { setLoopStart(s); setLoopEnd(e); }} />
                        <Playhead time={playhead} duration={duration} height={lanesH} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs text-white/50">Drag the yellow region to loop a phrase · ⌘/Ctrl-scroll to zoom · slow it down to learn it.</p>
            </div>
          </div>
        </div>

        {/* MASTER SECTION — its own thing */}
        <div className="mx-auto mt-6 max-w-6xl border border-white/15 bg-black/30 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.3em] text-white/40">Master</div>
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <button onClick={() => setPlaying((p) => !p)} className="h-10 w-10 border border-white/30 text-sm transition active:scale-95 hover:bg-white/10">{playing ? "❚❚" : "▶"}</button>
              <button onClick={() => setLoopEnabled((l) => !l)} className={`h-10 border px-4 text-xs uppercase tracking-[0.2em] transition active:scale-95 ${loopEnabled ? "border-yellow-400/70 text-yellow-400" : "border-white/20 text-white/50 hover:text-white"}`}>⟲ Loop</button>
            </div>

            <div className="flex items-center gap-2">
              {[0.25, 0.5, 0.75, 1].map((v) => (
                <button key={v} onClick={() => setSpeed(v)} className={`border px-2 py-1 text-xs transition active:scale-95 ${Math.abs(speed - v) < 0.001 ? "border-white/60 text-white" : "border-white/15 text-white/50 hover:text-white"}`}>{v}×</button>
              ))}
              <span className="ml-2 text-xs text-white/40">Loop {(loopEnd - loopStart).toFixed(1)}s · {speed.toFixed(2)}×</span>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-white/50">
                Master<input type="range" min={0} max={1} step={0.01} value={master} onChange={(e) => setMaster(parseFloat(e.target.value))} className="w-32 accent-white" />
              </label>
              <button onClick={() => { /* → engine.exportMix() */ }} title="Download full mix"
                className="flex items-center gap-2 border border-white/30 px-3 py-2 text-xs uppercase tracking-[0.2em] text-white/70 transition active:scale-95 hover:bg-white/10 hover:text-white">
                <DownloadIcon className="h-4 w-4" /> Download
              </button>
            </div>

            <div className="flex flex-wrap items-start gap-6">
              <Knob label="Speed" value={speed} min={0} max={2} step={0.1} format={(v) => `${v.toFixed(1)}x`} onChange={setSpeed} />
              <Knob label="Transpose" value={transpose} min={-24} max={24} step={1} format={(v) => `${v > 0 ? "+" : ""}${v} st`} onChange={setTranspose} />
              <Knob label="Cents" value={cents} min={-100} max={100} step={1} format={(v) => `${v > 0 ? "+" : ""}${v}¢`} onChange={setCents} />
              <div className="flex flex-col items-center gap-1">
                <div className="flex overflow-hidden border border-white/20 text-[10px]">
                  <button onClick={() => setA432dir((d) => (d === -1 ? 0 : -1))} style={a432dir === -1 ? { color: model.accent, borderColor: model.accent } : undefined}
                    className={`px-2 py-2 leading-none transition active:scale-95 ${a432dir === -1 ? "bg-white/10" : "text-white/55 hover:text-white"}`}>440→432</button>
                  <button onClick={() => setA432dir((d) => (d === 1 ? 0 : 1))} style={a432dir === 1 ? { color: model.accent, borderColor: model.accent } : undefined}
                    className={`border-l border-white/20 px-2 py-2 leading-none transition active:scale-95 ${a432dir === 1 ? "bg-white/10" : "text-white/55 hover:text-white"}`}>432→440</button>
                </div>
                <span className="text-[10px] tabular-nums text-white/45">{a432dir ? `${a432dir > 0 ? "+" : "−"}${A432_MAG}¢ · ` : ""}Ref {refHz.toFixed(1)} Hz</span>
                <span className="text-[10px] uppercase tracking-[0.2em] text-white/40"></span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---------- ABOUT PAGE (diffusion fade-in / inverse fade-out) ---------- */
function About({ onBack, exiting }: { onBack: () => void; exiting: boolean }) {
  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

  const sections = [
    { k: "01", t: "What it is", d: " Creative station for your audio separation needs" },
    { k: "02", t: "How it works", d: "[ Replace this with the pipeline / models overview. ]" },
    { k: "03", t: "The models", d: "HTDemucs" },
    { k: "04", t: "Built by", d: "Tom Huihan Zhou" },
  ];

  return (
    <div>
      <div className="fixed inset-0 -z-10 bg-black/60" />
      <div className="pointer-events-none fixed inset-0 z-40 mix-blend-soft-light"
        style={{ backgroundImage: noise, backgroundSize: "180px 180px", opacity: 0,
          animation: exiting ? "grainIn 0.7s ease-in forwards" : "grainOut 1.1s ease-out forwards" }} />

      <main className={`relative z-10 min-h-screen px-6 py-10 text-zinc-100 ${exiting ? "animate-[diffuseOut_0.7s_ease-in_forwards]" : "animate-[diffuseIn_1.1s_ease-out_both]"}`}>
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between">
            <button onClick={onBack} className="text-xs uppercase tracking-[0.25em] text-white/50 transition active:scale-95 hover:text-white/90">← Theseus</button>
            <span className="text-[10px] uppercase tracking-[0.3em] text-white/35">About</span>
          </div>

          <div className="mt-20">
            <span className="text-[10px] uppercase tracking-[0.4em] text-white/40">Theseus // Audio ML</span>
            <h1 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">About</h1>
            <p className="mt-6 text-base leading-8 text-white/70">
              Theseus is an audio source separation engine powered by Machine Learning <br />
              Theseus is built to solve a few problems that I wished had a quick, and user friednly options during my
              music journey. <br />
              Theseus allows me to separate stem, drums, bass, and others for transcription and when I wanted to hear separate instruments clearer. <br />
              For when I wanted to jam to a song that I couldn't find backkingtracks for. <br />
              For when I wanted to learn a song by ear but that symbol is just ringing a little too loud. <br />
              For when I wanted to jam to the oldies that were recorded in 432hz. <br />
              For whern I wanted to brute force loop practice through an intense part of music <br />
              For when I wanted to pretend to be Hanz Zimmer so I separate out the score from the film.
              For when my voice is too reverby on a recording, and maybe i can salvage it.
              For when I want to learn, make, and explore. <br />

              What is it for you?
            </p>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2">
            {sections.map((s) => (
              <div key={s.k} className="relative border border-white/15 bg-black/25 p-5 backdrop-blur-[2px]">
                <div className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-white/40" />
                <div className="pointer-events-none absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r border-white/40" />
                <span className="text-[10px] uppercase tracking-[0.3em] text-white/35">{s.k}</span>
                <h2 className="mt-2 text-lg font-semibold tracking-tight">{s.t}</h2>
                <p className="mt-2 text-sm leading-7 text-white/60">{s.d}</p>
              </div>
            ))}
          </div>

          <p className="mt-16 text-xs uppercase tracking-[0.3em] text-white/30">— Decomp, Recomp —</p>
        </div>
      </main>
    </div>
  );
}

type View = "intro" | "studio" | "about";

export default function Home() {
  const [view, setView] = useState<View>("intro");
  const [exiting, setExiting] = useState(false);
  const [aboutExiting, setAboutExiting] = useState(false);

  const enter = () => { if (exiting || view !== "intro") return; setExiting(true); setTimeout(() => { setView("studio"); setExiting(false); }, 650); };
  const back = () => setView("intro");

  const goAbout = () => { if (view !== "intro") return; setView("about"); };
  const backFromAbout = () => { if (aboutExiting) return; setAboutExiting(true); setTimeout(() => { setView("intro"); setAboutExiting(false); }, 700); };

  return (
    <div className={`relative min-h-screen ${display.className}`}>
      <div className="fixed inset-0 -z-10 bg-[url('/back.jpg')] bg-cover bg-center bg-no-repeat" />

      {view === "intro" && (
        <main className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <div className="animate-[title-in_1s_ease-out_both] motion-reduce:animate-none">
            <div role="button" tabIndex={0} aria-label="Enter Theseus" onClick={enter}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && enter()}
              className={`group relative cursor-pointer select-none px-16 py-14 text-center outline-none transition-transform duration-300 ease-out hover:scale-[1.015] active:scale-[0.99] ${exiting ? "animate-[boxExit_0.65s_ease-in_forwards]" : ""}`}>
              <div className="absolute inset-0 border border-white/15 transition-all duration-300 group-hover:border-white/50 group-hover:bg-white/[0.04] group-hover:backdrop-blur-[1px]" />
              <div className="absolute left-0 top-0 h-5 w-5 border-l border-t border-white/40 transition-all duration-300 group-hover:h-7 group-hover:w-7 group-hover:border-white/80" />
              <div className="absolute right-0 top-0 h-5 w-5 border-r border-t border-white/40 transition-all duration-300 group-hover:h-7 group-hover:w-7 group-hover:border-white/80" />
              <div className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-white/40 transition-all duration-300 group-hover:h-7 group-hover:w-7 group-hover:border-white/80" />
              <div className="absolute bottom-0 right-0 h-5 w-5 border-b border-r border-white/40 transition-all duration-300 group-hover:h-7 group-hover:w-7 group-hover:border-white/80" />
              <div className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-white/30" />
              <div className="absolute bottom-0 left-1/2 h-2 w-px -translate-x-1/2 bg-white/30" />
              <div className="absolute left-0 top-1/2 h-px w-2 -translate-y-1/2 bg-white/30" />
              <div className="absolute right-0 top-1/2 h-px w-2 -translate-y-1/2 bg-white/30" />
              <span className="absolute -top-6 left-0 text-[10px] uppercase tracking-[0.25em] text-white/40">Theseus</span>
              <button
                onClick={(e) => { e.stopPropagation(); goAbout(); }}
                onKeyDown={(e) => e.stopPropagation()}
                className="absolute -top-6 right-0 text-[10px] uppercase tracking-[0.25em] text-white/40 outline-none transition active:scale-95 hover:text-white/90">
                About
              </button>
              <span className="absolute -bottom-6 left-0 text-[10px] uppercase tracking-[0.25em] text-white/40">TZ</span>
              <span className="absolute -bottom-6 right-0 translate-x-2 text-[10px] uppercase tracking-[0.3em] text-white/0 transition-all duration-300 group-hover:translate-x-0 group-hover:text-white/80">Enter →</span>
              <div className="flex flex-col items-center gap-6">
                <div className="[perspective:1000px]">
                  <h1 className="text-5xl font-bold tracking-tight text-black animate-[rotateDisplay_6s_ease-in-out_infinite] motion-reduce:animate-none dark:text-zinc-50"><SplitText idle>THESEUS</SplitText></h1>
                </div>
                <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-300"><SplitText>- Decomp, Recomp -</SplitText></p>
                <p className="max-w-md text-base leading-8 text-zinc-600 dark:text-zinc-400"><SplitText>Music / Audio Source Separation Tool powered by Machine Learning</SplitText></p>
              </div>
            </div>
          </div>
        </main>
      )}

      {view === "about" && <About onBack={backFromAbout} exiting={aboutExiting} />}

      {view === "studio" && <Studio onBack={back} />}

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes title-in { 0% { opacity: 0; transform: translateY(0.5em) scale(0.96); filter: blur(6px);} 60% { opacity: 1; filter: blur(0);} 100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0);} }
        @keyframes boxExit { 0% { opacity: 1; transform: scale(1); filter: blur(0);} 25% { transform: scale(1.03) translateX(0.06em); filter: blur(0.5px);} 35% { transform: scale(1.02) translateX(-0.06em);} 100% { opacity: 0; transform: scale(1.28); filter: blur(10px);} }
        @keyframes studioIn { 0% { opacity: 0; transform: translateY(0.6em); filter: blur(4px);} 100% { opacity: 1; transform: translateY(0); filter: blur(0);} }
        @keyframes rotateDisplay { 0%,100% { transform: rotateY(-14deg) rotateX(2deg);} 50% { transform: rotateY(14deg) rotateX(-2deg);} }
        @keyframes diffuseIn { 0% { opacity: 0; filter: blur(26px) saturate(0.35); transform: scale(1.04);} 55% { opacity: 1;} 100% { opacity: 1; filter: blur(0) saturate(1); transform: scale(1);} }
        @keyframes diffuseOut { 0% { opacity: 1; filter: blur(0) saturate(1); transform: scale(1);} 100% { opacity: 0; filter: blur(26px) saturate(0.35); transform: scale(1.04);} }
        @keyframes grainOut { from { opacity: 0.5;} to { opacity: 0;} }
        @keyframes grainIn { from { opacity: 0;} to { opacity: 0.5;} }
        @keyframes glitchBase { 0%,39%,45%,77%,81%,100% { transform: translate(0,0);} 40% { transform: translate(0.012em,0);} 41% { transform: translate(-0.012em,0);} 43% { transform: translate(0.006em,0);} 78% { transform: translate(-0.01em,0);} 79% { transform: translate(0.008em,0);} }
        @keyframes glitchRed { 0%,39% { opacity:0; transform: translate(0,0);} 40% { opacity:.85; transform: translate(-0.05em,0.01em); clip-path: inset(8% 0 58% 0);} 42% { opacity:.85; transform: translate(0.035em,-0.01em); clip-path: inset(62% 0 12% 0);} 44% { opacity:.85; transform: translate(-0.03em,0); clip-path: inset(0 0 0 0);} 45%,77% { opacity:0; transform: translate(0,0);} 78% { opacity:.85; transform: translate(-0.06em,0); clip-path: inset(30% 0 40% 0);} 80% { opacity:.85; transform: translate(0.03em,0); clip-path: inset(0 0 70% 0);} 81%,100% { opacity:0; transform: translate(0,0);} }
        @keyframes glitchBlue { 0%,39% { opacity:0; transform: translate(0,0);} 40% { opacity:.85; transform: translate(0.05em,-0.01em); clip-path: inset(12% 0 54% 0);} 42% { opacity:.85; transform: translate(-0.035em,0.01em); clip-path: inset(58% 0 16% 0);} 44% { opacity:.85; transform: translate(0.03em,0); clip-path: inset(0 0 0 0);} 45%,77% { opacity:0; transform: translate(0,0);} 78% { opacity:.85; transform: translate(0.06em,0); clip-path: inset(35% 0 35% 0);} 80% { opacity:.85; transform: translate(-0.03em,0); clip-path: inset(0 0 65% 0);} 81%,100% { opacity:0; transform: translate(0,0);} }
      ` }} />
    </div>
  );
}