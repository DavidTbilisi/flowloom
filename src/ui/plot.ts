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
  const pad = { l: 60, r: 16, t: 16, b: 28 };
  const x0 = pad.l, x1 = W - pad.r, y0 = H - pad.b, y1 = pad.t;
  const T = r.t;
  const tMin = T[0] ?? 0, tMax = T[T.length - 1] ?? 1;

  const vis = [...store.visible].filter((n) => r.series.has(n));
  const ov = store.overlay;
  let lo = Infinity, hi = -Infinity;
  const grow = (v: number) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  for (const n of vis) for (const v of r.series.get(n)!) grow(v);
  // Overlays must fit in view too: Monte Carlo bands, observed data, comparison run.
  for (const n of vis) {
    const b = ov.bands?.bands.get(n);
    if (b) { for (const v of b.p05) grow(v); for (const v of b.p95) grow(v); }
    const cmp = ov.compare?.result.series.get(n);
    if (cmp) for (const v of cmp) grow(v);
  }
  if (ov.data) for (const [name, col] of ov.data.columns) if (vis.includes(name)) for (const v of col) grow(v);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { hi = lo + 1; lo -= 1; }
  // Frame the y-axis on *round* numbers (0, 250, 500…) rather than padded data
  // extremes — the difference between a chart that looks designed and one that
  // looks dumped. niceScale also gives us the gridline values for free.
  const yScale = niceScale(lo, hi, 5);
  lo = yScale.lo; hi = yScale.hi;

  const sx = (t: number) => x0 + ((t - tMin) / (tMax - tMin || 1)) * (x1 - x0);
  const sy = (v: number) => y0 - ((v - lo) / (hi - lo || 1)) * (y0 - y1);

  // horizontal gridlines + y labels at nice ticks
  g.font = "11px ui-monospace, monospace";
  g.lineWidth = 1;
  g.textBaseline = "middle";
  for (const v of yScale.ticks) {
    const y = sy(v);
    if (y < y1 - 0.5 || y > y0 + 0.5) continue;
    const zero = Math.abs(v) < (hi - lo) * 1e-9;
    g.strokeStyle = zero ? "#3a4150" : "#2a2f3a";
    g.globalAlpha = zero ? 0.9 : 0.4;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.globalAlpha = 1; g.fillStyle = "#9aa3b2"; g.textAlign = "right"; g.fillText(fmt(v), x0 - 8, y);
  }
  // x labels at nice time ticks
  g.textBaseline = "alphabetic"; g.textAlign = "center";
  for (const t of niceScale(tMin, tMax, 6).ticks) {
    if (t < tMin - 1e-9 || t > tMax + 1e-9) continue;
    g.fillStyle = "#9aa3b2"; g.fillText(fmt(t), sx(t), H - 8);
  }
  g.textAlign = "left";
  g.strokeStyle = "#3a4150";
  g.beginPath(); g.moveTo(x0, y1); g.lineTo(x0, y0); g.lineTo(x1, y0); g.stroke();

  // ── overlays (drawn behind the canonical series) ──
  // Monte Carlo bands: a translucent p05–p95 ribbon per visible series.
  if (ov.bands) {
    for (const n of vis) {
      const b = ov.bands.bands.get(n);
      if (!b) continue;
      const bt = ov.bands.t;
      g.fillStyle = colorFor(r, n); g.globalAlpha = 0.16;
      g.beginPath();
      for (let i = 0; i < bt.length; i++) g[i ? "lineTo" : "moveTo"](sx(bt[i]!), sy(b.p95[i]!));
      for (let i = bt.length - 1; i >= 0; i--) g.lineTo(sx(bt[i]!), sy(b.p05[i]!));
      g.closePath(); g.fill();
      g.globalAlpha = 0.5; g.strokeStyle = colorFor(r, n); g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < bt.length; i++) g[i ? "lineTo" : "moveTo"](sx(bt[i]!), sy(b.p50[i]!));
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  // Comparison run: the other model's series as a dashed line.
  if (ov.compare) {
    g.lineWidth = 2; g.setLineDash([5, 4]); g.globalAlpha = 0.85;
    for (const n of vis) {
      const arr = ov.compare.result.series.get(n);
      if (!arr) continue;
      const ct = ov.compare.result.t;
      g.strokeStyle = colorFor(r, n);
      g.beginPath();
      for (let i = 0; i < arr.length; i++) g[i ? "lineTo" : "moveTo"](sx(ct[i]!), sy(arr[i]!));
      g.stroke();
    }
    g.setLineDash([]); g.globalAlpha = 1;
  }

  // Observed data: hollow markers at each sample of a matching visible series.
  if (ov.data) {
    for (const n of vis) {
      const col = ov.data.columns.get(n);
      if (!col) continue;
      g.strokeStyle = colorFor(r, n); g.fillStyle = "#11151c"; g.lineWidth = 1.5;
      for (let i = 0; i < ov.data.t.length; i++) {
        const v = col[i]!;
        if (!Number.isFinite(v)) continue;
        g.beginPath(); g.arc(sx(ov.data.t[i]!), sy(v), 2.8, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    }
  }

  // series — a soft gradient fill under each line, then the line itself with
  // round joins. The fill is what reads as "a real chart"; it's kept subtle
  // (and skipped when several series overlap so they don't muddy each other).
  g.lineJoin = "round"; g.lineCap = "round";
  const fillBase = Math.max(y1, Math.min(y0, sy(0))); // fill down to the zero line (clamped)
  const single = vis.length === 1;
  for (const n of vis) {
    const arr = r.series.get(n)!;
    const col = colorFor(r, n);

    if (single || vis.length <= 3) {
      const grad = g.createLinearGradient(0, y1, 0, y0);
      grad.addColorStop(0, col + (single ? "38" : "22")); // ~22%/13% alpha at top
      grad.addColorStop(1, col + "00");
      g.fillStyle = grad;
      g.beginPath();
      let open = false;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i]!)) continue;
        const X = sx(T[i]!), Y = sy(arr[i]!);
        if (!open) { g.moveTo(X, fillBase); g.lineTo(X, Y); open = true; } else g.lineTo(X, Y);
      }
      if (open) {
        // close back down to the baseline at the last finite x
        let lastX = x0;
        for (let i = arr.length - 1; i >= 0; i--) { if (Number.isFinite(arr[i]!)) { lastX = sx(T[i]!); break; } }
        g.lineTo(lastX, fillBase); g.closePath(); g.fill();
      }
    }

    g.lineWidth = 2.25; g.strokeStyle = col;
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

/** Round a number to a "nice" 1/2/5 × 10ⁿ value (for axis steps). */
function niceNum(range: number, round: boolean): number {
  if (range <= 0 || !Number.isFinite(range)) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  const nf = round
    ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
    : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}

/**
 * A "nice" axis scale: bounds snapped outward to round numbers and the tick
 * values between them. Turns a data range like [-3.9, 1063.9] into
 * [0, 1000] step 250 — the classic Heckbert axis algorithm.
 */
export function niceScale(lo: number, hi: number, maxTicks: number): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return { lo, hi, ticks: [lo, hi] };
  const step = niceNum(niceNum(hi - lo, false) / Math.max(1, maxTicks - 1), true);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceLo; v <= niceHi + step * 0.5; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v); // clean up −0 / float dust
  }
  return { lo: niceLo, hi: niceHi, ticks };
}
