# Stress-test models

A ladder of generated `.flow` models, from trivial to extreme, for stressing
every layer of the engine and UI. **Regenerate with `npm run gen:stress`** —
do not hand-edit these files.

Open one in the studio via the **📂** button (or drag it onto the editor). The
timings below were measured by the generator on the synchronous TS backend; in
the browser, models marked *worker + WASM* run off the main thread on the WASM
backend, so the UI stays responsive.

> **Diagram note:** the diagram is a pan/zoom **infinite canvas** — scroll to
> zoom, drag to pan, **Fit** to frame. Small models animate; larger ones lay
> out on a scalable grid, and very large ones (the grids, mega chain) render as
> a navigable dot-map. For the raw numbers, the **Plot** and **Table** tabs are
> still the fastest read at scale.

| # | Model | Stocks | +Internal | Steps | Series | Loops | Backend | TS time | What it stresses |
|---|---|--:|--:|--:|--:|--:|---|--:|---|
| 01 | **Minimal — one stock** | 1 | 0 | 200 | 2 | 0 | TS (sync) | 4 ms | smoke test; parser + integrator baseline |
| 02 | **Small nonlinear — coupled oscillator** | 2 | 0 | 2000 | 3 | 2 | TS (sync) | 12 ms | RK4 accuracy; small feedback loops |
| 03 | **Feature zoo — every builtin, delay, lookup, test input** | 2 | 9 | 1200 | 15 | 17 | TS (sync) | 55 ms | compile.ts delays/smoothing; all builtins; tables; WASM imports |
| 04 | **Diffusion chain — 50 stocks** | 50 | 0 | 600 | 101 | 99 | TS (sync) | 52 ms | medium state count; topological ordering; self-balancing loops |
| 05 | **Diffusion grid — 144 stocks** | 144 | 0 | 400 | 288 | 3+ (capped) | TS (sync) | 305 ms | dense neighbour coupling; many edges; diagram node count |
| 06 | **Loop-dense ring — many feedback cycles** | 14 | 0 | 800 | 28 | 400+ (capped) | TS (sync) | 127 ms | influence graph + simple-cycle enumeration; the MAX_LOOPS cap |
| 07 | **Long horizon — few stocks, 200k steps** | 1 | 0 | 200000 | 2 | 1 | TS (sync) | 1074 ms | integrator loop + result recording over a huge step count |
| 08 | **Diffusion chain — 300 stocks (worker + WASM)** | 300 | 0 | 7000 | 601 | 400+ (capped) | worker + WASM | n/a ms | crosses the worker/WASM threshold; off-thread simulation · _runs off-thread on WASM_ |
| 09 | **Diffusion grid — 1024 stocks (WASM)** | 1024 | 0 | 2000 | 2048 | skipped | worker + WASM | n/a ms | large dense model; WASM module size; memory bandwidth · _runs off-thread on WASM_ |
| 10 | **Mega chain — 3000 stocks, trig per node (apex)** | 3000 | 0 | 1000 | 9001 | skipped | worker + WASM | n/a ms | the most complex: parser, WASM codegen, compute-heavy deriv, worker · _runs off-thread on WASM_ |
| 11 | **Stiff blow-up — exercises the non-finite halt** | 1 | 0 | 100 | 2 | 1 | TS (sync) | 0 ms | overflow detection; the graceful stop-with-note path · _halts (non-finite) — expected_ |

## How to drive a stress run

1. **Small (01–03):** sanity — everything should be instant and animate smoothly.
2. **Medium (04–07):** watch the plot/table; 06 should report many loops (the
   loop counter caps at 400); 07 pushes a very high step count through the integrator.
3. **Large (08–10):** these cross the worker/WASM threshold — you should see the
   *“simulating large model in a worker…”* banner and a responsive UI while they run.
4. **11-stiff-blowup:** intentionally diverges; the engine halts cleanly and shows a
   non-finite note instead of producing garbage or hanging.

