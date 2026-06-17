import type { Store } from "./store.js";
import type { SimResult, InfluenceGraph, Loop } from "../engine/index.js";

// ── Animated causal diagram ─────────────────────────────────────────────────
// Nodes are laid out radially (stocks clustered with the flows/aux they touch).
// During playback each stock box fills to its normalized current level and shows
// its value; signed edges (green = same direction, red = opposite) animate with
// marching ants. Hovering a loop chip traces that loop and shows its R/B badge.

interface Pos { x: number; y: number; }
interface Layout {
  graph: InfluenceGraph;
  loops: Loop[];
  order: string[];
  pos: Map<string, Pos>;
  isStock: Set<string>;
  isInternal: Set<string>;
  range: Map<string, { lo: number; hi: number }>;
}

const W_REF = 720;
const H = 460;

export class Diagram {
  private layout: Layout | null = null;
  highlight: number | null = null;
  dash = 0;

  constructor(private svg: SVGSVGElement) {}

  /** Recompute layout when the model changes. */
  setModel(store: Store): void {
    const run = store.run;
    if (!run.ok || !run.loops || !run.result) {
      this.layout = null;
      this.svg.innerHTML = `<text x="20" y="30" fill="#9aa3b2" font-size="12">run a model to see its causal diagram</text>`;
      return;
    }
    this.layout = buildLayout(run.loops.graph, run.loops.loops, run.result);
    this.render(store);
  }

  render(store: Store): void {
    const L = this.layout;
    if (!L) return;
    const W = this.svg.clientWidth || W_REF;
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.svg.setAttribute("height", String(H));

    // recompute positions for the live width
    placeRadial(L, W);

    const result = store.run.result!;
    const frame = store.frame;
    const hi = this.highlight;
    const hlEdges = hi != null ? new Set(L.loops[hi]!.edges.map((e) => e.from + "|" + e.to)) : null;
    const hlNodes = hi != null ? new Set(L.loops[hi]!.nodes) : null;

    const col = (s: number) => (s > 0 ? "#5fd17a" : s < 0 ? "#f0746a" : "#7a8294");
    let body = "";

    // edges
    for (const e of L.graph.edges) {
      const c = col(e.sign);
      const on = hlEdges ? hlEdges.has(e.from + "|" + e.to) : true;
      const op = hlEdges ? (on ? 1 : 0.08) : 0.8;
      const w = hlEdges && on ? 3.4 : 1.7;
      const A = L.pos.get(e.from)!, B = L.pos.get(e.to)!;
      const dash = on ? `stroke-dasharray="7 5" stroke-dashoffset="${-this.dash}"` : "";
      if (e.from === e.to) {
        const r = L.isStock.has(e.from) ? 26 : 22;
        body += `<path d="M ${A.x - 9} ${A.y - r + 3} A 15 15 0 1 1 ${A.x + 9} ${A.y - r + 3}" fill="none" stroke="${c}" stroke-width="${w}" opacity="${op}" ${dash} marker-end="url(#fa-${c.slice(1)})"/>`;
        continue;
      }
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const ra = L.isStock.has(e.from) ? 30 : 24, rb = L.isStock.has(e.to) ? 30 : 24;
      const sx = A.x + ux * ra, sy = A.y + uy * ra, ex = B.x - ux * rb, ey = B.y - uy * rb;
      const dir = idx(L.order, e.from) < idx(L.order, e.to) ? 1 : -1;
      const off = 0.16 * len * dir;
      const mx = (sx + ex) / 2 - uy * off, my = (sy + ey) / 2 + ux * off;
      body += `<path d="M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}" fill="none" stroke="${c}" stroke-width="${w}" opacity="${op}" ${dash} marker-end="url(#fa-${c.slice(1)})"/>`;
    }

    // nodes
    for (const n of L.order) {
      const p = L.pos.get(n)!;
      const dim = hlNodes ? (hlNodes.has(n) ? 1 : 0.25) : 1;
      const value = result.series.get(n)?.[frame];
      if (L.isStock.has(n)) {
        const r = L.range.get(n)!;
        const frac = value != null && Number.isFinite(value) ? clamp01((value - r.lo) / (r.hi - r.lo || 1)) : 0;
        const bw = 84, bh = 36, bx = p.x - bw / 2, by = p.y - bh / 2;
        body += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="7" fill="#11161e" stroke="#6ad1c7" stroke-width="1.6" opacity="${dim}"/>`;
        // fill level (from the bottom)
        const fh = bh * frac;
        body += `<clipPath id="clip-${cssId(n)}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="7"/></clipPath>`;
        body += `<rect clip-path="url(#clip-${cssId(n)})" x="${bx}" y="${by + bh - fh}" width="${bw}" height="${fh}" fill="#6ad1c7" opacity="${0.22 * dim}"/>`;
        body += `<text x="${p.x}" y="${by - 5}" text-anchor="middle" font-size="11" fill="#e6e9ef" opacity="${dim}" font-family="monospace">${esc(short(n))}</text>`;
        body += `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="12" fill="#6ad1c7" opacity="${dim}" font-family="monospace">${value != null ? fmtShort(value) : ""}</text>`;
      } else {
        const internal = L.isInternal.has(n);
        const stroke = internal ? "#3a4150" : "#4a5566";
        const bw = 78, bh = 30, bx = p.x - bw / 2, by = p.y - bh / 2;
        body += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="15" fill="#141821" stroke="${stroke}" stroke-width="1.3" opacity="${dim}"/>`;
        body += `<text x="${p.x}" y="${p.y - 1}" text-anchor="middle" font-size="10.5" fill="#cdd3df" opacity="${dim}" font-family="monospace">${esc(short(internal ? "delay" : n))}</text>`;
        if (value != null && Number.isFinite(value))
          body += `<text x="${p.x}" y="${p.y + 11}" text-anchor="middle" font-size="10" fill="#8b93a3" opacity="${dim}" font-family="monospace">${fmtShort(value)}</text>`;
      }
    }

    // R/B badge at the highlighted loop's centroid
    if (hi != null && hlNodes) {
      const ns = [...hlNodes];
      const c = ns.reduce((a, n) => ({ x: a.x + L.pos.get(n)!.x, y: a.y + L.pos.get(n)!.y }), { x: 0, y: 0 });
      c.x /= ns.length; c.y /= ns.length;
      const k = L.loops[hi]!.polarity;
      const kc = k === "R" ? "#5fd17a" : k === "B" ? "#f0c14b" : "#9aa3b2";
      body += `<circle cx="${c.x}" cy="${c.y}" r="16" fill="${kc}"/><text x="${c.x}" y="${c.y + 6}" text-anchor="middle" font-size="16" font-weight="700" fill="#06231f">${k}</text>`;
    }

    const cols = ["#5fd17a", "#f0746a", "#7a8294"];
    const defs = cols
      .map((c) => `<marker id="fa-${c.slice(1)}" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="${c}"/></marker>`)
      .join("");
    this.svg.innerHTML = `<defs>${defs}</defs>${body}`;
  }
}

function buildLayout(graph: InfluenceGraph, loops: Loop[], result: SimResult): Layout {
  const isStock = new Set(result.stockNames);
  const isInternal = new Set(graph.nodes.filter((n) => n.includes("#")));

  // cluster: each stock, then the neighbours it touches
  const order: string[] = [];
  const seen = new Set<string>();
  const nbrs = (n: string) => {
    const r = new Set<string>();
    for (const e of graph.edges) {
      if (e.from === n) r.add(e.to);
      if (e.to === n) r.add(e.from);
    }
    return [...r];
  };
  for (const s of result.stockNames) {
    if (!seen.has(s)) { order.push(s); seen.add(s); }
    for (const nb of nbrs(s)) if (!seen.has(nb)) { order.push(nb); seen.add(nb); }
  }
  for (const n of graph.nodes) if (!seen.has(n)) { order.push(n); seen.add(n); }

  const range = new Map<string, { lo: number; hi: number }>();
  for (const n of graph.nodes) {
    const arr = result.series.get(n);
    if (arr) {
      let lo = Infinity, hi = -Infinity;
      for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      range.set(n, { lo: Number.isFinite(lo) ? Math.min(lo, 0) : 0, hi: Number.isFinite(hi) ? hi : 1 });
    } else {
      range.set(n, { lo: 0, hi: 1 });
    }
  }

  return { graph, loops, order, pos: new Map(), isStock, isInternal, range };
}

function placeRadial(L: Layout, W: number): void {
  const N = Math.max(1, L.order.length);
  const cx = W / 2, cy = H / 2, R = Math.max(70, Math.min(W, H) / 2 - 62);
  L.order.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    L.pos.set(n, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });
}

const idx = (order: string[], n: string) => order.indexOf(n);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const short = (n: string) => (n.length > 12 ? n.slice(0, 11) + "…" : n);
const cssId = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_");
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
function fmtShort(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-2 || a >= 1e4)) return v.toExponential(1);
  return (Math.round(v * 100) / 100).toString();
}
