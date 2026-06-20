// Generate a ladder of stress-test models, from trivial to extreme, into
// `stress/*.flow`. Each file is a valid, runnable model; the script also parses,
// analyzes, and simulates every one to validate it and print a performance
// table, then writes stress/README.md. Run with: npm run gen:stress
//
// These are deliberately procedural and scale far past the curated `examples/`.
// They exercise the parser, the compiled-TS evaluator, the WASM backend + worker
// (large models), loop detection (many cycles), delays/lookups/test-inputs, the
// long-horizon integrator, and the non-finite halt path.

import { writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import process from "node:process";
import { parseModel } from "../src/lang/index.js";
import { simulate, buildPlan, compile, worthWasm } from "../src/engine/index.js";
import { analyzeLoops } from "../src/engine/index.js";

// ── model builders ───────────────────────────────────────────────────────────

const header = (title: string, lines: string[]): string =>
  `# ${title}\n# (generated stress model — see stress/README.md)\n${lines.join("\n")}\n`;

/** A 1-D diffusion chain (optionally a ring) of N stocks. */
function chain(N: number, opts: { ring?: boolean; to: number; dt: number; trig?: boolean }): string {
  const L: string[] = [];
  for (let i = 0; i < N; i++) L.push(`stock S${i} = ${10 + (i % 7)}`);
  L.push(`param k = 0.05`);
  L.push(`aux inflow = 2 + step(3, 5)`);
  for (let i = 0; i < N; i++) {
    const left = i === 0 ? (opts.ring ? `S${N - 1}` : `S0`) : `S${i - 1}`;
    if (opts.trig) L.push(`aux g${i} = 1 + 0.2 * sin(S${i} * 0.01 + ${i})`);
    const gain = opts.trig ? ` * g${i}` : ``;
    const src = i === 0 && !opts.ring ? `inflow` : `k * (${left} - S${i})${gain}`;
    L.push(`flow f${i} = ${src}`);
    L.push(`d(S${i}) = f${i} - 0.01 * S${i}`);
  }
  L.push(`sim dt=${opts.dt} to=${opts.to} method=rk4`);
  L.push(`plot S0 S${(N / 2) | 0} S${N - 1}`);
  return L.join("\n");
}

/** A 2-D diffusion grid (R×C stocks each coupled to its 4 neighbours). */
function grid(R: number, C: number, opts: { to: number; dt: number }): string {
  const L: string[] = [];
  const name = (r: number, c: number) => `C_${r}_${c}`;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) L.push(`stock ${name(r, c)} = ${5 + ((r + c) % 9)}`);
  L.push(`param k = 0.1`);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const nb: string[] = [];
      if (r > 0) nb.push(name(r - 1, c));
      if (r < R - 1) nb.push(name(r + 1, c));
      if (c > 0) nb.push(name(r, c - 1));
      if (c < C - 1) nb.push(name(r, c + 1));
      const sum = nb.map((n) => `(${n} - ${name(r, c)})`).join(" + ");
      L.push(`flow flux_${r}_${c} = k * (${sum})`);
      L.push(`d(${name(r, c)}) = flux_${r}_${c}`);
    }
  }
  L.push(`sim dt=${opts.dt} to=${opts.to} method=rk4`);
  L.push(`plot ${name(0, 0)} ${name((R / 2) | 0, (C / 2) | 0)} ${name(R - 1, C - 1)}`);
  return L.join("\n");
}

/** A small but loop-dense ring: each stock couples to several neighbours, so the
 *  influence graph has many simple cycles (stresses loop enumeration + the cap). */
function loopDense(N: number, reach: number): string {
  const L: string[] = [];
  for (let i = 0; i < N; i++) L.push(`stock N${i} = ${20 + i}`);
  L.push(`param k = 0.08`);
  for (let i = 0; i < N; i++) {
    const terms: string[] = [];
    for (let d = 1; d <= reach; d++) {
      terms.push(`(N${(i + d) % N} - N${i})`);
      terms.push(`(N${(i - d + N) % N} - N${i})`);
    }
    L.push(`flow d${i} = k * (${terms.join(" + ")})`);
    L.push(`d(N${i}) = d${i}`);
  }
  L.push(`sim dt=0.05 to=40 method=rk4`);
  L.push(`plot N0 N${(N / 2) | 0}`);
  return L.join("\n");
}

/** Every builtin, delay, smoothing, lookup, and test input in one model. */
function featureZoo(): string {
  return [
    `stock Reservoir [m3] = 500   # main accumulator`,
    `stock Buffer    [m3] = 50`,
    ``,
    `param baseIn = 12`,
    `param leak   = 0.03`,
    `param tau    = 4`,
    ``,
    `table response = (0,0) (100,4) (250,9) (400,16) (550,20) (700,21)`,
    ``,
    `# test inputs`,
    `aux  inflow   = baseIn + step(6, 20) + pulse(40, 5) + ramp(0.2, 60, 90)`,
    `# every stateless math builtin`,
    `aux  mathy    = min(Reservoir, 9e9) + max(0, Buffer) + abs(Buffer - 100)`,
    `aux  mathier  = exp(-leak) + ln(Reservoir + 1) + log(Buffer + 1) + log10(Reservoir + 1)`,
    `aux  geo      = sqrt(Reservoir) + pow(Buffer, 0.5) + sin(t * 0.2) + cos(t * 0.1) + tan(0.05)`,
    `aux  rounded  = floor(inflow) + ceil(leak) + round(Buffer) + sign(Buffer - 60)`,
    `aux  gated    = if(Reservoir - 400, clamp(Reservoir, 0, 800), Buffer)`,
    `aux  curve    = response(Reservoir)`,
    ``,
    `# delays & smoothing -> internal stocks`,
    `aux  smoothIn = smooth(inflow, tau)`,
    `aux  smoothI2 = smoothi(inflow, tau, 10)`,
    `aux  smooth3x = smooth3(inflow, tau)`,
    `flow arrive   = delay3(smoothIn, 6)`,
    `flow trickle  = delay1(Buffer * 0.1, 3)`,
    ``,
    `flow drain    = leak * Reservoir + curve * 0.01`,
    `d(Reservoir)  = arrive - drain + (mathy + mathier + geo + rounded + gated) * 0`,
    `d(Buffer)     = trickle - 0.1 * Buffer + smoothI2 * 0 + smooth3x * 0`,
    ``,
    `sim dt=0.1 to=120 method=rk4`,
    `plot Reservoir Buffer inflow arrive smoothIn`,
  ].join("\n");
}

// ── the stress ladder ────────────────────────────────────────────────────────

interface Spec {
  file: string;
  title: string;
  stresses: string;
  source: string;
}

const SPECS: Spec[] = [
  { file: "01-minimal", title: "Minimal — one stock", stresses: "smoke test; parser + integrator baseline",
    source: header("Minimal", ["stock Tank = 0", "param rate = 2", "flow fill = rate", "d(Tank) = fill", "sim dt=0.1 to=20 method=rk4", "plot Tank"]) },
  { file: "02-nonlinear-small", title: "Small nonlinear — coupled oscillator", stresses: "RK4 accuracy; small feedback loops",
    source: header("Damped oscillator (2 stocks)", [
      "stock x = 1", "stock v = 0", "param w2 = 4", "param damp = 0.2",
      "flow accel = -w2 * x - damp * v", "d(x) = v", "d(v) = accel",
      "sim dt=0.02 to=40 method=rk4", "plot x v"]) },
  { file: "03-feature-zoo", title: "Feature zoo — every builtin, delay, lookup, test input", stresses: "compile.ts delays/smoothing; all builtins; tables; WASM imports",
    source: header("Feature zoo", [featureZoo()]) },
  { file: "04-chain-50", title: "Diffusion chain — 50 stocks", stresses: "medium state count; topological ordering; self-balancing loops",
    source: header("Chain ×50", [chain(50, { to: 60, dt: 0.1 })]) },
  { file: "05-grid-12x12", title: "Diffusion grid — 144 stocks", stresses: "dense neighbour coupling; many edges; diagram node count",
    source: header("Grid 12×12", [grid(12, 12, { to: 40, dt: 0.1 })]) },
  { file: "06-loops-dense", title: "Loop-dense ring — many feedback cycles", stresses: "influence graph + simple-cycle enumeration; the MAX_LOOPS cap",
    source: header("Loop-dense ring (reach 3)", [loopDense(14, 3)]) },
  { file: "07-long-horizon", title: "Long horizon — few stocks, 200k steps", stresses: "integrator loop + result recording over a huge step count",
    source: header("Long horizon", [
      "stock P = 10", "param r = 0.4", "param cap = 1000",
      "flow growth = r * P * (1 - P / cap)", "d(P) = growth",
      "sim dt=0.001 to=200 method=rk4", "plot P"]) },
  { file: "08-chain-300", title: "Diffusion chain — 300 stocks (worker + WASM)", stresses: "crosses the worker/WASM threshold; off-thread simulation",
    source: header("Chain ×300", [chain(300, { to: 700, dt: 0.1 })]) },
  { file: "09-grid-32x32", title: "Diffusion grid — 1024 stocks (WASM)", stresses: "large dense model; WASM module size; memory bandwidth",
    source: header("Grid 32×32", [grid(32, 32, { to: 200, dt: 0.1 })]) },
  { file: "10-mega-3000", title: "Mega chain — 3000 stocks, trig per node (apex)", stresses: "the most complex: parser, WASM codegen, compute-heavy deriv, worker",
    source: header("Mega ring ×3000 (compute-heavy)", [chain(3000, { ring: true, to: 80, dt: 0.08, trig: true })]) },
  { file: "11-stiff-blowup", title: "Stiff blow-up — exercises the non-finite halt", stresses: "overflow detection; the graceful stop-with-note path",
    source: header("Stiff blow-up (dt too large)", [
      "stock X = 1", "param r = 5", "flow boom = r * X * X", "d(X) = boom",
      "sim dt=0.5 to=50 method=euler", "plot X"]) },
];

// ── write + validate + report ────────────────────────────────────────────────
// Wrapped in main() and gated on the env flag the npm script sets, so importing
// this module never deletes/writes stress/* (mirrors the gen-llms guard).

function main() {
const DIR = "stress";
if (!existsSync(DIR)) mkdirSync(DIR);
for (const f of readdirSync(DIR)) if (f.endsWith(".flow")) unlinkSync(`${DIR}/${f}`);

interface Row {
  file: string; title: string; stresses: string;
  stocks: number; internal: number; vars: number; steps: number; series: number;
  loops: string; backend: string; ms: string; note: string;
}

const rows: Row[] = [];

for (const spec of SPECS) {
  const src = spec.source.replace(/\s*$/, "") + "\n";
  writeFileSync(`${DIR}/${spec.file}.flow`, src);

  let row: Row = {
    file: spec.file, title: spec.title, stresses: spec.stresses,
    stocks: 0, internal: 0, vars: 0, steps: 0, series: 0, loops: "—", backend: "—", ms: "—", note: "",
  };
  try {
    const model = parseModel(src);
    const c = compile(model);
    const plan = buildPlan(c);
    const steps = Math.max(1, Math.round((model.settings.to - model.settings.start) / model.settings.dt));
    row.stocks = model.stocks.length;
    row.internal = c.state.length - model.stocks.length;
    row.vars = model.vars.length;
    row.steps = steps;
    const heavy = worthWasm(plan, model.settings);
    row.backend = heavy ? "worker + WASM" : "TS (sync)";
    row.series = plan.outNames.length;

    // Time the synchronous TS run only for models the app would run that way.
    // For the worker/WASM-bound models a sync-TS time would misrepresent the
    // real path, so we validate structure (parse+compile+plan) but don't run.
    if (!heavy) {
      const t0 = performance.now();
      const r = simulate(model);
      row.ms = (performance.now() - t0).toFixed(0);
      if (r.note) row.note = r.note.includes("non-finite") ? "halts (non-finite) — expected" : r.note;
    } else {
      row.ms = "n/a";
      row.note = "runs off-thread on WASM";
    }

    // loop analysis is bounded-time but still meaningful mostly on small/medium
    // models; skip it on the huge ones to keep the generator quick.
    if (c.state.length <= 500) {
      const lr = analyzeLoops(model);
      row.loops = `${lr.loops.length}${lr.capped ? "+ (capped)" : ""}`;
    } else {
      row.loops = "skipped";
    }
  } catch (e) {
    row.note = "PARSE/RUN ERROR: " + (e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
  rows.push(row);
  console.log(
    `${spec.file.padEnd(18)} stocks=${String(row.stocks).padStart(4)} ` +
    `steps=${String(row.steps).padStart(6)} series=${String(row.series).padStart(4)} ` +
    `loops=${row.loops.padStart(10)} ${row.backend.padEnd(13)} ${row.ms.padStart(6)} ms  ${row.note}`,
  );
}

// ── README ──
const md: string[] = [
  "# Stress-test models",
  "",
  "A ladder of generated `.flow` models, from trivial to extreme, for stressing",
  "every layer of the engine and UI. **Regenerate with `npm run gen:stress`** —",
  "do not hand-edit these files.",
  "",
  "Open one in the studio via the **📂** button (or drag it onto the editor). The",
  "timings below were measured by the generator on the synchronous TS backend; in",
  "the browser, models marked *worker + WASM* run off the main thread on the WASM",
  "backend, so the UI stays responsive.",
  "",
  "> **Diagram note:** the diagram is a pan/zoom **infinite canvas** — scroll to",
  "> zoom, drag to pan, **Fit** to frame. Small models animate; larger ones lay",
  "> out on a scalable grid, and very large ones (the grids, mega chain) render as",
  "> a navigable dot-map. For the raw numbers, the **Plot** and **Table** tabs are",
  "> still the fastest read at scale.",
  "",
  "| # | Model | Stocks | +Internal | Steps | Series | Loops | Backend | TS time | What it stresses |",
  "|---|---|--:|--:|--:|--:|--:|---|--:|---|",
  ...rows.map((r) =>
    `| ${r.file.slice(0, 2)} | **${r.title}** | ${r.stocks} | ${r.internal} | ${r.steps} | ${r.series} | ${r.loops} | ${r.backend} | ${r.ms} ms | ${r.stresses}${r.note ? ` · _${r.note}_` : ""} |`),
  "",
  "## How to drive a stress run",
  "",
  "1. **Small (01–03):** sanity — everything should be instant and animate smoothly.",
  "2. **Medium (04–07):** watch the plot/table; 06 should report many loops (the",
  "   loop counter caps at 400); 07 pushes a very high step count through the integrator.",
  "3. **Large (08–10):** these cross the worker/WASM threshold — you should see the",
  "   *“simulating large model in a worker…”* banner and a responsive UI while they run.",
  "4. **11-stiff-blowup:** intentionally diverges; the engine halts cleanly and shows a",
  "   non-finite note instead of producing garbage or hanging.",
  "",
];
writeFileSync(`${DIR}/README.md`, md.join("\n") + "\n");
console.log(`\nwrote ${SPECS.length} stress models + README to ${DIR}/`);
}

if (process.env.GEN_STRESS) main();
