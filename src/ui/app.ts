import { Store, type Tab } from "./store.js";
import { drawPlot, colorFor, fmt } from "./plot.js";
import { Diagram } from "./diagram.js";
import { EXAMPLES, DEFAULT_EXAMPLE } from "../examples/index.js";
import { setSimSetting } from "./model-edit.js";
import { renderHelp } from "./help.js";
import { readHash, writeHash, shareUrl, downloadFlow, enableDropLoad } from "./persist.js";

// ── App shell ────────────────────────────────────────────────────────────────
// Wires the editor, toolbar, tabbed views, and the playback transport to a
// single Store, and runs one requestAnimationFrame clock that drives the
// animated plot cursor and diagram.

export function mountApp(root: HTMLElement): Store {
  const store = new Store();
  root.innerHTML = SHELL;

  const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const src = $<HTMLTextAreaElement>("#src");
  const exampleSel = $<HTMLSelectElement>("#example");
  const dtInput = $<HTMLInputElement>("#dt");
  const toInput = $<HTMLInputElement>("#to");
  const methodSel = $<HTMLSelectElement>("#method");
  const errEl = $<HTMLDivElement>("#err");
  const plotCanvas = $<HTMLCanvasElement>("#plot");
  const legendEl = $<HTMLDivElement>("#legend");
  const diagramSvg = $<SVGSVGElement>("#diagram");
  const loopChips = $<HTMLDivElement>("#loopChips");
  const tableWrap = $<HTMLDivElement>("#tableWrap");
  const loopsWrap = $<HTMLDivElement>("#loopsWrap");
  const helpWrap = $<HTMLDivElement>("#helpWrap");

  const diagram = new Diagram(diagramSvg);
  helpWrap.innerHTML = renderHelp();

  // examples dropdown
  for (const ex of EXAMPLES) {
    const o = document.createElement("option");
    o.value = ex.name;
    o.textContent = ex.name;
    exampleSel.appendChild(o);
  }

  // ── transports (one under Plot, one under Diagram) ──
  const transports = [$<HTMLElement>("#transport-plot"), $<HTMLElement>("#transport-diagram")].map((el) =>
    buildTransport(el, store),
  );

  // ── build/run ──
  let buildTimer: number | undefined;
  function rebuild() {
    store.build(src.value);
    reflectSettings();
    renderStructure();
    syncFrameUI();
    writeHash(src.value);
  }
  function scheduleRebuild() {
    window.clearTimeout(buildTimer);
    buildTimer = window.setTimeout(rebuild, 250);
  }

  function reflectSettings() {
    if (store.run.ok && store.run.model) {
      const s = store.run.model.settings;
      dtInput.value = String(s.dt);
      toInput.value = String(s.to);
      methodSel.value = s.method;
    }
  }

  // editor
  src.addEventListener("input", scheduleRebuild);
  src.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      rebuild();
    }
  });
  $<HTMLButtonElement>("#run").onclick = rebuild;

  const flash = (btn: HTMLButtonElement, label: string) => {
    const prev = btn.textContent;
    btn.textContent = label;
    window.setTimeout(() => (btn.textContent = prev), 1100);
  };
  const copyBtn = $<HTMLButtonElement>("#copy");
  copyBtn.onclick = () => { navigator.clipboard?.writeText(src.value); flash(copyBtn, "✓ Copied"); };
  const shareBtn = $<HTMLButtonElement>("#share");
  shareBtn.onclick = () => { navigator.clipboard?.writeText(shareUrl(src.value)); flash(shareBtn, "✓ Link copied"); };
  $<HTMLButtonElement>("#download").onclick = () => downloadFlow(src.value);

  // open a .flow file (button + drag-and-drop onto the editor)
  const fileInput = $<HTMLInputElement>("#fileInput");
  $<HTMLButtonElement>("#open").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) f.text().then((text) => { src.value = text; rebuild(); });
    fileInput.value = "";
  };
  enableDropLoad($<HTMLElement>(".editor-wrap"), (text) => { src.value = text; rebuild(); });

  exampleSel.onchange = () => {
    const ex = EXAMPLES.find((e) => e.name === exampleSel.value);
    if (ex) { src.value = ex.source; rebuild(); store.setFrame(store.frameCount - 1); }
  };

  // toolbar settings rewrite the canonical `sim` line so the text stays the source of truth
  const applySetting = (key: "dt" | "to" | "method", value: string) => {
    src.value = setSimSetting(src.value, key, value);
    rebuild();
  };
  dtInput.onchange = () => applySetting("dt", dtInput.value);
  toInput.onchange = () => applySetting("to", toInput.value);
  methodSel.onchange = () => applySetting("method", methodSel.value);

  // tabs
  root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.onclick = () => store.setTab(b.dataset.tab as Tab);
  });

  // ── render: structural (on rebuild) ──
  function renderStructure() {
    // error / warnings panel
    const run = store.run;
    errEl.className = "err";
    if (!run.ok && run.error) {
      errEl.className = "err show error";
      errEl.textContent = "✗ " + run.error;
    } else if (run.note) {
      errEl.className = "err show warn";
      errEl.textContent = "⚠ " + run.note;
    } else {
      const warns = run.diagnostics.filter((d) => d.severity === "warning");
      if (warns.length) {
        errEl.className = "err show warn";
        errEl.textContent = warns.map((w) => `⚠ line ${w.loc.line}: ${w.message}`).join("\n");
      }
    }

    diagram.highlight = null;
    diagram.setModel(store);
    renderLoopChips();
    renderLoops();
    renderTable();
    renderLegend();
  }

  function renderLoopChips() {
    const run = store.run;
    if (!run.ok || !run.loops) { loopChips.innerHTML = ""; return; }
    const loops = run.loops.loops;
    if (!loops.length) { loopChips.innerHTML = `<span class="hint" style="margin:0">no feedback loops (open-loop model)</span>`; return; }
    loopChips.innerHTML = "";
    loops
      .map((lp, i) => ({ lp, i }))
      .sort((a, b) => rank(a.lp.polarity) - rank(b.lp.polarity) || a.lp.edges.length - b.lp.edges.length)
      .forEach(({ lp, i }) => {
        const el = document.createElement("span");
        el.className = "chip";
        const k = lp.polarity;
        const path = lp.nodes.join(" → ");
        el.innerHTML = `<span class="badge ${k === "?" ? "Q" : k}">${k}</span>${escapeHtml(path)}`;
        el.onmouseenter = () => { diagram.highlight = i; diagram.render(store); };
        el.onmouseleave = () => { diagram.highlight = null; diagram.render(store); };
        loopChips.appendChild(el);
      });
  }

  function renderLoops() {
    const run = store.run;
    if (!run.ok || !run.loops) { loopsWrap.innerHTML = ""; return; }
    const { loops, counts, capped } = run.loops;
    if (!loops.length) {
      loopsWrap.innerHTML = `<p class="hint">No feedback loops — this is an open-loop model (nothing feeds back on itself).</p>`;
      return;
    }
    let html = `<p class="loopcount"><span class="badge R">${counts.R} R</span><span class="badge B">${counts.B} B</span>` +
      (counts["?"] ? `<span class="badge Q">${counts["?"]} ?</span>` : "") +
      ` &nbsp;${loops.length} loop${loops.length > 1 ? "s" : ""}` + (capped ? ` (capped)` : "") + `</p>`;
    const sorted = [...loops].sort((a, b) => rank(a.polarity) - rank(b.polarity) || a.edges.length - b.edges.length);
    for (const lp of sorted) {
      let path = `<span class="node">${escapeHtml(lp.nodes[0]!)}</span>`;
      for (const e of lp.edges) {
        const sym = e.sign > 0 ? "+" : e.sign < 0 ? "−" : "?";
        const cls = e.sign > 0 ? "pos" : e.sign < 0 ? "neg" : "amb";
        path += ` <span class="lnk ${cls}">→<sup>${sym}</sup></span> <span class="node">${escapeHtml(e.to)}</span>`;
      }
      const label = lp.polarity === "R" ? "reinforcing" : lp.polarity === "B" ? "balancing" : "indeterminate";
      html += `<div class="loop"><span class="badge ${lp.polarity === "?" ? "Q" : lp.polarity}">${lp.polarity}</span>` +
        `<span class="looplabel">${label}</span><div class="path">${path}</div></div>`;
    }
    loopsWrap.innerHTML = html;
  }

  function renderTable() {
    const r = store.run.result;
    if (!r) { tableWrap.innerHTML = ""; return; }
    const cols = r.names;
    const N = r.t.length, every = Math.max(1, Math.floor(N / 16));
    const rows: number[] = [];
    for (let i = 0; i < N; i += every) rows.push(i);
    if (rows[rows.length - 1] !== N - 1) rows.push(N - 1);
    let html = `<table><tr><th>t</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
    for (const i of rows) {
      html += `<tr data-row="${i}"><td>${fmt(r.t[i]!)}</td>${cols.map((c) => `<td class="num">${fmt(r.series.get(c)![i]!)}</td>`).join("")}</tr>`;
    }
    html += `</table>`;
    tableWrap.innerHTML = html;
  }

  function renderLegend() {
    const r = store.run.result;
    legendEl.innerHTML = "";
    if (!r) return;
    for (const n of r.names) {
      const on = store.visible.has(n);
      const lab = document.createElement("label");
      lab.className = on ? "on" : "";
      lab.innerHTML = `<span class="sw" style="background:${colorFor(r, n)};opacity:${on ? 1 : 0.3}"></span>${escapeHtml(n)} <span class="val" data-series="${escapeHtml(n)}"></span>`;
      lab.onclick = () => { store.toggleSeries(n); renderLegend(); };
      legendEl.appendChild(lab);
    }
    updateLegendValues();
  }

  function updateLegendValues() {
    const r = store.run.result;
    if (!r) return;
    legendEl.querySelectorAll<HTMLElement>("[data-series]").forEach((el) => {
      const n = el.dataset.series!;
      const v = r.series.get(n)?.[store.frame];
      el.textContent = v != null ? fmt(v) : "";
    });
  }

  // ── tab visibility ──
  store.subscribe(() => {
    root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === store.tab),
    );
    root.querySelectorAll<HTMLElement>(".view").forEach((v) =>
      v.classList.toggle("hidden", v.id !== "view-" + store.tab),
    );
    if (store.tab === "plot") drawPlot(plotCanvas, store);
    if (store.tab === "diagram") diagram.render(store);
  });

  // ── frame channel: cheap per-frame repaint ──
  function syncFrameUI() {
    for (const t of transports) t.sync();
    if (store.tab === "plot") drawPlot(plotCanvas, store);
    if (store.tab === "diagram") diagram.render(store);
    updateLegendValues();
    highlightTableRow();
  }
  store.onFrame(syncFrameUI);

  function highlightTableRow() {
    const r = store.run.result;
    if (!r) return;
    tableWrap.querySelectorAll("tr.cursor").forEach((el) => el.classList.remove("cursor"));
    // nearest sampled row at/under current frame
    const rows = [...tableWrap.querySelectorAll<HTMLElement>("tr[data-row]")];
    let best: HTMLElement | undefined;
    for (const row of rows) if (Number(row.dataset.row) <= store.frame) best = row;
    best?.classList.add("cursor");
  }

  // ── animation clock ──
  let last = 0;
  function tick(ts: number) {
    const dtReal = last ? (ts - last) / 1000 : 0;
    last = ts;
    if (store.playing && store.frameCount > 1) {
      // play the whole run in ~6 seconds at speed 1
      const perSec = (store.frameCount / 6) * store.speed;
      const next = store.frame + perSec * dtReal;
      diagram.dash = (diagram.dash + 60 * dtReal * store.speed) % 1000;
      if (next >= store.frameCount - 1) {
        store.setFrame(store.frameCount - 1);
        store.setPlaying(false);
      } else {
        store.setFrame(next);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener("resize", () => {
    if (store.tab === "plot") drawPlot(plotCanvas, store);
    if (store.tab === "diagram") diagram.render(store);
  });

  // boot — a model in the URL hash (a shared link) wins over the default example
  const shared = readHash();
  src.value = shared ?? DEFAULT_EXAMPLE.source;
  exampleSel.value = shared ? "" : DEFAULT_EXAMPLE.name;
  rebuild();
  store.setTab("plot");

  return store;
}

// ── transport widget ─────────────────────────────────────────────────────────
function buildTransport(el: HTMLElement, store: Store) {
  el.innerHTML = `
    <button class="tbtn" data-act="start" title="to start">⏮</button>
    <button class="tbtn" data-act="play" title="play/pause">▶</button>
    <button class="tbtn" data-act="end" title="to end">⏭</button>
    <input type="range" min="0" max="100" value="100" />
    <span class="clock">t = 0</span>`;
  const slider = el.querySelector("input")!;
  const clock = el.querySelector(".clock")!;
  const playBtn = el.querySelector('[data-act="play"]') as HTMLButtonElement;

  slider.addEventListener("input", () => {
    store.setPlaying(false);
    const n = store.frameCount;
    store.setFrame((Number(slider.value) / 100) * (n - 1));
  });
  (el.querySelector('[data-act="start"]') as HTMLButtonElement).onclick = () => { store.setPlaying(false); store.setFrame(0); };
  (el.querySelector('[data-act="end"]') as HTMLButtonElement).onclick = () => { store.setPlaying(false); store.setFrame(store.frameCount - 1); };
  playBtn.onclick = () => {
    if (!store.playing && store.frame >= store.frameCount - 1) store.setFrame(0);
    store.setPlaying(!store.playing);
  };

  return {
    sync() {
      const n = store.frameCount;
      slider.value = String(n > 1 ? (store.frame / (n - 1)) * 100 : 0);
      clock.textContent = `t = ${fmt(store.currentTime)}`;
      playBtn.textContent = store.playing ? "⏸" : "▶";
    },
  };
}

const rank = (p: "R" | "B" | "?") => ({ R: 0, B: 1, "?": 2 })[p];
function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

const SHELL = `
<header>
  <h1><b>flow</b>loom</h1>
  <span class="tag">systems-thinking studio · stocks · flows · loops · animated</span>
  <span class="spacer"></span>
  <label class="tag" for="example">example</label>
  <select id="example"></select>
</header>
<main>
  <section class="left">
    <div class="toolbar">
      <button id="run" class="primary">▶ Run</button>
      <label>dt</label><input id="dt" type="number" step="0.01" value="0.1" />
      <label>to</label><input id="to" type="number" step="1" value="50" />
      <label>method</label>
      <select id="method"><option value="rk4">RK4</option><option value="euler">Euler</option></select>
      <button id="copy" class="ghost" title="copy model text">⧉ Copy</button>
      <button id="share" class="ghost" title="copy a shareable link">🔗 Share</button>
      <button id="download" class="ghost" title="download .flow">⤓</button>
      <button id="open" class="ghost" title="open a .flow file">📂</button>
      <input id="fileInput" type="file" accept=".flow,.txt,text/plain" style="display:none" />
    </div>
    <div class="editor-wrap"><textarea id="src" spellcheck="false"></textarea></div>
    <div id="err" class="err"></div>
  </section>
  <section class="right">
    <div class="tabs">
      <button data-tab="plot" class="active">Plot</button>
      <button data-tab="diagram">Diagram</button>
      <button data-tab="loops">Loops</button>
      <button data-tab="table">Table</button>
      <button data-tab="help">Format</button>
    </div>
    <div class="view" id="view-plot">
      <canvas id="plot" height="380"></canvas>
      <div class="transport" id="transport-plot"></div>
      <div class="legend" id="legend"></div>
    </div>
    <div class="view hidden" id="view-diagram">
      <p class="hint">Causal graph from the model's equations. <b style="color:var(--accent)">Boxes</b> are stocks (filling to their level),
        <b>pills</b> are flows/aux; <span style="color:var(--green)">green</span> links push the same direction,
        <span style="color:var(--red)">red</span> the opposite. <b>Press play</b> to animate, or hover a loop to trace it.</p>
      <svg id="diagram" height="460"></svg>
      <div class="transport" id="transport-diagram"></div>
      <div class="loopchips" id="loopChips"></div>
    </div>
    <div class="view hidden" id="view-loops">
      <p class="hint">Feedback loops, each labeled <b style="color:var(--green)">R</b> reinforcing or
        <b style="color:var(--warn)">B</b> balancing. Polarity is the product of link signs read at the
        initial state — nonlinear models can flip a loop's polarity as they evolve.</p>
      <div id="loopsWrap"></div>
    </div>
    <div class="view hidden" id="view-table">
      <p class="hint">Series sampled across the run. The highlighted row tracks the playback cursor.</p>
      <div id="tableWrap"></div>
    </div>
    <div class="view hidden" id="view-help"><div id="helpWrap"></div></div>
  </section>
</main>`;
