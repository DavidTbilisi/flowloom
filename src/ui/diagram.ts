import type { Store } from "./store.js";
import type { SimResult, InfluenceGraph, Loop } from "../engine/index.js";
import { colorFor } from "./plot.js";

// ── Animated causal diagram on an infinite (pan/zoom) canvas ─────────────────
// Nodes live in a fixed *virtual* coordinate space sized to the node count, so
// they never overlap regardless of how many there are; a viewport <g> with a
// pan/zoom transform is the "infinite canvas" you navigate. Small models get the
// full animated treatment (filling stocks, marching signed edges, loop tracing);
// large models scale down gracefully — static edges, then a dot-map — so a
// thousand-node model stays responsive. Wheel to zoom, drag to pan, Fit to frame.

interface Pos { x: number; y: number; }
interface Layout {
  graph: InfluenceGraph;
  loops: Loop[];
  order: string[];
  pos: Map<string, Pos>;
  isStock: Set<string>;
  isInternal: Set<string>;
  range: Map<string, { lo: number; hi: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const H = 460;
// rendering tiers by node count
const GRID_LIMIT = 60;      // radial cluster ≤ this, else a grid
const ANIM_LIMIT = 160;     // per-frame animation (marching ants, live fill) ≤ this
const FULL_LIMIT = 900;     // full boxes+labels ≤ this, else a dot-map
const EDGE_LIMIT = 1600;    // draw edges ≤ this, else omit them

interface View { x: number; y: number; k: number; }

export class Diagram {
  private layout: Layout | null = null;
  highlight: number | null = null;
  dash = 0;
  view: View = { x: 0, y: 0, k: 1 };
  /** small graphs animate every frame; large ones render once (static). */
  animated = true;
  // ── visual-builder edit mode ──
  editMode = false;
  tool: "select" | "connect" = "select";
  /** source node held while wiring a connection (Connect tool). */
  connectFrom: string | null = null;
  /** node whose inline editor is open (Select tool). */
  selected: string | null = null;
  /** fired when a named node is clicked in edit mode. */
  onNodePick: ((name: string) => void) | null = null;
  /** fired when a node is dragged to a new virtual position (edit mode). */
  onNodeMove: ((name: string, x: number, y: number) => void) | null = null;
  /** stored positions (from `# @pos` comments) that override auto-layout. */
  private positions = new Map<string, { x: number; y: number }>();
  /** last store seen, so pointer handlers can re-render during a node drag. */
  private store: Store | null = null;
  private onView: ((k: number) => void) | null = null;

  constructor(private svg: SVGSVGElement) {
    this.installPanZoom();
  }

  setOnView(fn: (k: number) => void) { this.onView = fn; }

  /** Supply stored node positions (parsed from `# @pos` comments) before setModel. */
  setPositions(p: Map<string, { x: number; y: number }>) { this.positions = p; }

  /** Recompute layout when the model changes, then frame it. */
  setModel(store: Store): void {
    const run = store.run;
    if (!run.ok || !run.loops || !run.result) {
      // In edit mode a transient error (mid-edit) shouldn't blank the canvas —
      // keep the last good layout so the user can keep clicking to fix it.
      if (this.editMode && this.layout) return;
      this.layout = null;
      this.svg.innerHTML = `<text x="20" y="30" fill="#9aa3b2" font-size="12">run a model to see its causal diagram</text>`;
      return;
    }
    this.layout = buildLayout(run.loops.graph, run.loops.loops, run.result, this.positions);
    this.animated = this.layout.order.length <= ANIM_LIMIT;
    this.render(store);
    // frame the graph on load, but never yank the view while the user edits
    if (!this.editMode) this.fit();
  }

  /** Per-frame hook: only re-render (for animation) when the graph is small.
   *  Edit mode renders statically so selection/connect cues hold still. */
  tick(store: Store): void {
    if (this.animated && !this.editMode) this.render(store);
  }

  /** Enter/leave builder edit mode; clears any in-flight selection. */
  setEditMode(on: boolean): void {
    this.editMode = on;
    this.connectFrom = null;
    this.selected = null;
    this.svg.classList.toggle("editing", on);
  }

  /** Draw/update the dashed "rubber band" from the connect source to the cursor. */
  private drawRubber(clientX: number, clientY: number): void {
    const vp = this.svg.querySelector(".vp");
    const from = this.connectFrom ? this.layout?.pos.get(this.connectFrom) : null;
    if (!vp || !from) return;
    const r = this.svg.getBoundingClientRect();
    const x = (clientX - r.left - this.view.x) / this.view.k;
    const y = (clientY - r.top - this.view.y) / this.view.k;
    let line = vp.querySelector(".rubber") as SVGLineElement | null;
    if (!line) {
      line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "rubber");
      vp.appendChild(line);
    }
    line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(x)); line.setAttribute("y2", String(y));
  }

  render(store: Store): void {
    const L = this.layout;
    if (!L) return;
    const W = this.svg.clientWidth || 720;
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.svg.setAttribute("height", String(H));

    this.store = store;
    const result = store.run.result;
    if (!result) return; // model errored after a good layout (edit mode) — keep last paint
    const frame = store.frame;
    const N = L.order.length;
    const hi = this.highlight;
    const hlEdges = hi != null ? new Set(L.loops[hi]!.edges.map((e) => e.from + "|" + e.to)) : null;
    const hlNodes = hi != null ? new Set(L.loops[hi]!.nodes) : null;
    const simplified = N > FULL_LIMIT;
    const straightEdges = simplified || N > GRID_LIMIT; // curves only for small radial graphs
    const col = (s: number) => (s > 0 ? "#5fd17a" : s < 0 ? "#f0746a" : "#7a8294");

    let body = "";

    // ── edges ──
    if (N <= EDGE_LIMIT) {
      let ei = -1;
      for (const e of L.graph.edges) {
        ei++;
        const c = col(e.sign);
        const on = hlEdges ? hlEdges.has(e.from + "|" + e.to) : true;
        const op = hlEdges ? (on ? 1 : 0.06) : simplified ? 0.5 : 0.8;
        const w = hlEdges && on ? 3.4 : 1.7;
        const A = L.pos.get(e.from)!, B = L.pos.get(e.to)!;
        const march = this.animated && on && !this.editMode;
        const dash = march ? `stroke-dasharray="7 5" stroke-dashoffset="${-this.dash}"` : "";
        const marker = simplified ? "" : `marker-end="url(#fa-${c.slice(1)})"`;
        // A signal dot travels the edge in the direction of causality while the
        // sim plays — Loopy's "feel the feedback" moment. Desynced per edge (ei)
        // so the graph pulses organically rather than in lockstep.
        const flowing = march && !simplified && this.dash > 0;
        const t = ((this.dash + ei * 37) % 80) / 80; // 0..1 along the edge
        if (e.from === e.to) {
          const r = L.isStock.has(e.from) ? 26 : 22;
          body += `<path d="M ${A.x - 9} ${A.y - r + 3} A 15 15 0 1 1 ${A.x + 9} ${A.y - r + 3}" fill="none" stroke="${c}" stroke-width="${w}" opacity="${op}" ${dash} ${marker}/>`;
          continue;
        }
        const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const ra = L.isStock.has(e.from) ? 30 : 24, rb = L.isStock.has(e.to) ? 30 : 24;
        const sx = A.x + ux * ra, sy = A.y + uy * ra, ex = B.x - ux * rb, ey = B.y - uy * rb;
        let dotX = 0, dotY = 0;
        if (straightEdges) {
          body += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${c}" stroke-width="${w}" opacity="${op}" ${marker}/>`;
          dotX = sx + (ex - sx) * t; dotY = sy + (ey - sy) * t;
        } else {
          const dir = idx(L.order, e.from) < idx(L.order, e.to) ? 1 : -1;
          const off = 0.16 * len * dir;
          const mx = (sx + ex) / 2 - uy * off, my = (sy + ey) / 2 + ux * off;
          body += `<path d="M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}" fill="none" stroke="${c}" stroke-width="${w}" opacity="${op}" ${dash} ${marker}/>`;
          const u = 1 - t; // point on the quadratic Bézier at parameter t
          dotX = u * u * sx + 2 * u * t * mx + t * t * ex;
          dotY = u * u * sy + 2 * u * t * my + t * t * ey;
        }
        if (flowing) body += `<circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="3.2" fill="${c}"/>`;
      }
    }

    // ── nodes ──
    for (const n of L.order) {
      const p = L.pos.get(n)!;
      const dim = hlNodes ? (hlNodes.has(n) ? 1 : 0.22) : 1;
      const value = result.series.get(n)?.[frame];
      const internal = L.isInternal.has(n);
      const helpKey = L.isStock.has(n) ? "ui:node-stock" : internal ? "ui:node-internal" : "ui:node-flow";
      const named = internal ? "" : ` data-name="${esc(n)}"`;

      // Each stock takes its plot colour, so the eye links a name in the editor,
      // its line on the plot, its swatch in the legend, and its box here — one
      // identity, one colour (the Desmos trick). Flows/aux stay neutral so the
      // green/red polarity of the *edges* reads clearly.
      const nodeColor = L.isStock.has(n) ? colorFor(result, n) : "";

      if (simplified) {
        // dot-map: a coloured dot is enough to navigate; details on hover
        const r = L.isStock.has(n) ? 5 : 3.5;
        const fill = L.isStock.has(n) ? nodeColor : internal ? "#3a4150" : "#7a8294";
        body += `<g data-help="${helpKey}"${named}><circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" opacity="${dim}"/></g>`;
        continue;
      }

      let g = "";
      if (L.isStock.has(n)) {
        const rng = L.range.get(n)!;
        const frac = value != null && Number.isFinite(value) ? clamp01((value - rng.lo) / (rng.hi - rng.lo || 1)) : 0;
        const bw = 84, bh = 36, bx = p.x - bw / 2, by = p.y - bh / 2;
        g += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="7" fill="#11161e" stroke="${nodeColor}" stroke-width="1.6" opacity="${dim}"/>`;
        const fh = bh * frac;
        g += `<clipPath id="clip-${cssId(n)}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="7"/></clipPath>`;
        g += `<rect clip-path="url(#clip-${cssId(n)})" x="${bx}" y="${by + bh - fh}" width="${bw}" height="${fh}" fill="${nodeColor}" opacity="${0.22 * dim}"/>`;
        g += `<text x="${p.x}" y="${by - 5}" text-anchor="middle" font-size="11" fill="#e6e9ef" opacity="${dim}" font-family="monospace">${esc(short(n))}</text>`;
        g += `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="12" fill="${nodeColor}" opacity="${dim}" font-family="monospace">${value != null ? fmtShort(value) : ""}</text>`;
      } else {
        const stroke = internal ? "#3a4150" : "#4a5566";
        const bw = 78, bh = 30, bx = p.x - bw / 2, by = p.y - bh / 2;
        g += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="15" fill="#141821" stroke="${stroke}" stroke-width="1.3" opacity="${dim}"/>`;
        g += `<text x="${p.x}" y="${p.y - 1}" text-anchor="middle" font-size="10.5" fill="#cdd3df" opacity="${dim}" font-family="monospace">${esc(short(internal ? "delay" : n))}</text>`;
        if (value != null && Number.isFinite(value))
          g += `<text x="${p.x}" y="${p.y + 11}" text-anchor="middle" font-size="10" fill="#8b93a3" opacity="${dim}" font-family="monospace">${fmtShort(value)}</text>`;
      }
      // builder cue: ring the connect-source (green) or selected (accent) node
      if (this.editMode && (n === this.connectFrom || n === this.selected)) {
        const stockN = L.isStock.has(n);
        const bw = stockN ? 94 : 88, bh = stockN ? 46 : 40;
        const c = n === this.connectFrom ? "#5fd17a" : "#6ad1c7";
        g = `<rect x="${p.x - bw / 2}" y="${p.y - bh / 2}" width="${bw}" height="${bh}" rx="${stockN ? 10 : 20}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="4 3"/>` + g;
      }
      body += `<g data-help="${helpKey}"${named}>${g}</g>`;
    }

    // R/B badge at the highlighted loop's centroid (skip in dot-map)
    if (hi != null && hlNodes && !simplified) {
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

    const t = this.view;
    // a hint when the graph is too big to wire up edges
    const note = N > EDGE_LIMIT
      ? `<text x="14" y="${H - 14}" fill="#9aa3b2" font-size="12" font-family="monospace">${N} nodes — edges hidden; dot-map only. Use Plot/Table for data, scroll to zoom.</text>`
      : simplified
        ? `<text x="14" y="${H - 14}" fill="#9aa3b2" font-size="12" font-family="monospace">${N} nodes — simplified dot-map. Hover a dot for details; scroll to zoom.</text>`
        : "";
    this.svg.innerHTML = `<defs>${defs}</defs><g class="vp" transform="translate(${t.x} ${t.y}) scale(${t.k})">${body}</g>${note}`;
    this.onView?.(this.view.k);
  }

  // ── pan / zoom (the infinite canvas) ──
  private applyTransform(): void {
    const vp = this.svg.querySelector(".vp");
    if (vp) vp.setAttribute("transform", `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
    this.onView?.(this.view.k);
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const W = this.svg.clientWidth || 720;
    const px = cx ?? W / 2, py = cy ?? H / 2;
    const k2 = clamp(this.view.k * factor, 0.02, 8);
    this.view.x = px - ((px - this.view.x) / this.view.k) * k2;
    this.view.y = py - ((py - this.view.y) / this.view.k) * k2;
    this.view.k = k2;
    this.applyTransform();
  }

  /** Frame the whole graph in the viewport. */
  fit(): void {
    const L = this.layout;
    if (!L) return;
    const W = this.svg.clientWidth || 720;
    const b = L.bounds, pad = 60;
    const gw = b.maxX - b.minX + pad * 2, gh = b.maxY - b.minY + pad * 2;
    const k = clamp(Math.min(W / gw, H / gh), 0.02, 4);
    this.view.k = k;
    this.view.x = W / 2 - ((b.minX + b.maxX) / 2) * k;
    this.view.y = H / 2 - ((b.minY + b.maxY) / 2) * k;
    this.applyTransform();
  }

  private installPanZoom(): void {
    const svg = this.svg;
    svg.addEventListener("wheel", (e) => {
      if (!this.layout) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    let dragging = false, lx = 0, ly = 0, downX = 0, downY = 0, downNode: string | null = null;
    svg.addEventListener("pointerdown", (e) => {
      if (!this.layout) return;
      dragging = true; lx = e.clientX; ly = e.clientY; downX = e.clientX; downY = e.clientY;
      // in edit mode, pressing on a node drags that node; empty space pans
      downNode = this.editMode ? nodeNameAt(e.target) : null;
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = "grabbing";
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) {
        // not pressing: show a rubber-band line while wiring a connection
        if (this.editMode && this.tool === "connect" && this.connectFrom) this.drawRubber(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (downNode && this.layout) {
        // move just this node in virtual space (screen delta ÷ zoom)
        const p = this.layout.pos.get(downNode);
        if (p) { p.x += dx / this.view.k; p.y += dy / this.view.k; if (this.store) this.render(this.store); }
      } else {
        this.view.x += dx; this.view.y += dy;
        this.applyTransform();
      }
    });
    const end = (e: PointerEvent) => {
      dragging = false; svg.style.cursor = "grab"; try { svg.releasePointerCapture(e.pointerId); } catch { /* */ }
      if (this.editMode && downNode) {
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
        const p = this.layout?.pos.get(downNode);
        // a press with no real movement is a pick; a drag persists the new position
        if (moved < 5) this.onNodePick?.(downNode);
        else if (p) this.onNodeMove?.(downNode, p.x, p.y);
      }
      downNode = null;
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.style.cursor = "grab";
  }
}

// ── layout ────────────────────────────────────────────────────────────────────
function buildLayout(graph: InfluenceGraph, loops: Loop[], result: SimResult, overrides?: Map<string, Pos>): Layout {
  const isStock = new Set(result.stockNames);
  const isInternal = new Set(graph.nodes.filter((n) => n.includes("#")));

  // cluster: each stock, then the neighbours it touches
  const order: string[] = [];
  const seen = new Set<string>();
  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes) adj.set(n, new Set());
  for (const e of graph.edges) { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); }
  for (const s of result.stockNames) {
    if (!seen.has(s)) { order.push(s); seen.add(s); }
    for (const nb of adj.get(s) ?? []) if (!seen.has(nb)) { order.push(nb); seen.add(nb); }
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

  const pos = layoutPositions(order, isStock);
  // stored `# @pos` positions win over the computed auto-layout
  if (overrides) for (const n of order) { const o = overrides.get(n); if (o) pos.set(n, { x: o.x, y: o.y }); }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }

  return { graph, loops, order, pos, isStock, isInternal, range, bounds: { minX, minY, maxX, maxY } };
}

/** Place nodes in a fixed virtual space sized so they never overlap. */
function layoutPositions(order: string[], isStock: Set<string>): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const N = Math.max(1, order.length);
  if (N <= GRID_LIMIT) {
    // radial — radius grows with N so labels have room
    const spacing = 150;
    const R = Math.max(140, (N * spacing) / (2 * Math.PI));
    order.forEach((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      pos.set(n, { x: R * Math.cos(a), y: R * Math.sin(a) });
    });
  } else {
    // grid — compact, readable, tiles a big canvas you pan around
    const cols = Math.ceil(Math.sqrt(N * 1.7));
    const sx = isStock ? 150 : 150, sy = 104;
    order.forEach((n, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      pos.set(n, { x: c * sx, y: r * sy });
    });
  }
  return pos;
}

/** The model name of the diagram node under an event target, if any. */
function nodeNameAt(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest("[data-name]") : null;
  return el?.getAttribute("data-name") ?? null;
}

const idx = (order: string[], n: string) => order.indexOf(n);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const short = (n: string) => (n.length > 12 ? n.slice(0, 11) + "…" : n);
const cssId = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_");
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
function fmtShort(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-2 || a >= 1e4)) return v.toExponential(1);
  return (Math.round(v * 100) / 100).toString();
}
