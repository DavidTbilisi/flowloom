import type { Store } from "./store.js";
import type { SimResult } from "../engine/index.js";

// Time-series plot on a canvas. Draws the visible series and a vertical cursor
// at the animation frame, with a dot on each series at the current time.

export const PALETTE = ["#6ad1c7", "#f0c14b", "#6aa8f0", "#f0746a", "#5fd17a", "#c89bf0", "#f0986a", "#7ed3e6"];

export function colorFor(result: SimResult, name: string): string {
  const i = result.names.indexOf(name);
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}

export function drawPlot(canvas: HTMLCanvasElement, store: Store): void {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 700;
  const H = 380;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);

  const r = store.run.result;
  if (!r) return;
  const pad = { l: 60, r: 16, t: 14, b: 28 };
  const x0 = pad.l, x1 = W - pad.r, y0 = H - pad.b, y1 = pad.t;
  const T = r.t;
  const tMin = T[0] ?? 0, tMax = T[T.length - 1] ?? 1;

  const vis = [...store.visible].filter((n) => r.series.has(n));
  let lo = Infinity, hi = -Infinity;
  for (const n of vis) for (const v of r.series.get(n)!) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { hi = lo + 1; lo -= 1; }
  const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;

  const sx = (t: number) => x0 + ((t - tMin) / (tMax - tMin || 1)) * (x1 - x0);
  const sy = (v: number) => y0 - ((v - lo) / (hi - lo || 1)) * (y0 - y1);

  // grid + axes
  g.font = "11px ui-monospace, monospace";
  g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4, y = sy(v);
    g.strokeStyle = "#2a2f3a"; g.globalAlpha = 0.35;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.globalAlpha = 1; g.fillStyle = "#9aa3b2"; g.fillText(fmt(v), 6, y + 3);
  }
  for (let k = 0; k <= 5; k++) {
    const t = tMin + ((tMax - tMin) * k) / 5, x = sx(t);
    g.fillStyle = "#9aa3b2"; g.fillText(fmt(t), x - 8, H - 8);
  }
  g.strokeStyle = "#3a4150";
  g.beginPath(); g.moveTo(x0, y1); g.lineTo(x0, y0); g.lineTo(x1, y0); g.stroke();

  // series
  g.lineWidth = 2;
  for (const n of vis) {
    const arr = r.series.get(n)!;
    g.strokeStyle = colorFor(r, n);
    g.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i]!)) { started = false; continue; }
      const X = sx(T[i]!), Y = sy(arr[i]!);
      if (!started) { g.moveTo(X, Y); started = true; } else g.lineTo(X, Y);
    }
    g.stroke();
  }

  // time cursor + dots at the current frame
  const fi = store.frame;
  if (fi >= 0 && fi < T.length) {
    const cx = sx(T[fi]!);
    g.strokeStyle = "#e6e9ef"; g.globalAlpha = 0.5; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, y1); g.lineTo(cx, y0); g.stroke();
    g.globalAlpha = 1;
    for (const n of vis) {
      const v = r.series.get(n)![fi]!;
      if (!Number.isFinite(v)) continue;
      g.fillStyle = colorFor(r, n);
      g.beginPath(); g.arc(cx, sy(v), 3.5, 0, Math.PI * 2); g.fill();
    }
  }
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
  return (Math.round(v * 1000) / 1000).toString();
}
