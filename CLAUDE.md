# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

flowloom is a **text-first systems-thinking studio** (Vensim-style stocks/flows/loops) that runs in the browser. The plain-text `.flow` model is *canonical*; the diagram, plots, and animation are all derived from it. The design goal is that an AI can read and edit a model entirely as text. See `README.md` and `docs/` for the full picture.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server (HMR). |
| `npm run build` | `tsc --noEmit` typecheck, then a Vite production build to `dist/`. |
| `npm test` | Vitest contract tests (Node, `tests/unit`). `npm run test:watch` to watch. |
| `npm run test:e2e` | Playwright e2e (`tests/e2e`); auto-starts the dev server on :4317. Needs `npm run test:e2e:install` once. |
| `npm run test:all` | Both suites. |
| `npm run gen:examples` | Regenerate `examples/*.flow` from the canonical embedded source. |

Run a single unit test file: `npx vitest run tests/unit/engine.test.ts`. A single e2e test: `npx playwright test -g "playback advances"`.

## Architecture (the data flow)

`text (.flow)` → **`src/lang`** parses to a `Model` (AST) → **`src/engine/compile`** expands delays into internal stocks → **`src/engine/simulator`** integrates (Euler/RK4) to a `SimResult` → **`src/ui`** renders plot, animated diagram, table, loops. `src/engine/loops` derives the signed influence graph for R/B loop detection. Full version: `docs/architecture.md`.

Three layers, strictly separated:
- **`src/lang`** — tokenizer, Pratt expression parser (`expr.ts`), line-grammar model parser (`parser.ts`), shared `types.ts`. **No `eval`/`new Function`** — expressions are an inspectable AST interpreted by `src/engine/eval.ts`. This is deliberate (safety for AI/shared model text, plus dependency extraction and numeric differentiation).
- **`src/engine`** — pure TypeScript, **no DOM imports**, so it runs in Node (tests) and a future CLI. Integrator, builtins, delay/lookup handling, loop analysis.
- **`src/ui`** — the only DOM-aware layer. `store.ts` is the observable state; `app.ts` wires everything and owns the single `requestAnimationFrame` animation clock.

## Things to know before editing

- **Keep `src/engine` and `src/lang` DOM-free.** Their portability to Node is what makes the contract tests (and the planned CLI) possible. If you import from `src/ui` into them, you break this.
- **Stateful builtins are compiled, not interpreted.** `smooth*`/`delay1`/`delay3` are rewritten into internal stocks in `compile.ts` (named `delay#N`, which can't collide with user identifiers). That's why they integrate correctly under RK4 and show up as nodes in the loop graph. Stateless functions live in `builtins.ts`.
- **The text is the single source of truth.** UI controls that change settings rewrite the `sim` line via `src/ui/model-edit.ts` rather than holding separate state. Preserve that invariant.
- **Loop polarity is read at `t = start` only** (numerical perturbation at the initial operating point). Nonlinear models can flip polarity over time — intentional, and surfaced in the UI/docs.
- **Examples are generated, not hand-maintained.** The canonical copy is `src/examples/index.ts` (embedded so the app needs no network); `examples/*.flow` are produced by `npm run gen:examples`. Edit the source, then regenerate — don't edit the `.flow` files directly.
- **Tests are contracts.** Unit tests pin language semantics and numeric output against closed-form solutions / invariants; changing them is a deliberate language change, not a refactor. The app exposes its store on `window.flowloom` for e2e and tooling.
- **The help/learning subsystem is derived from the model, like everything else.** `src/ui/highlight.ts` is a *pure, lossless* tokenizer (its tokens must rebuild the source verbatim) used both to paint the editor overlay and to find the token under the mouse; keep it DOM-free so it stays unit-testable. `src/ui/help-content.ts` resolves identifier help straight from the parsed AST — a contract test (`tests/unit/help.test.ts`) asserts every keyword/builtin/reserved name has an entry, so extending the language without adding help fails CI. Contextual help flows to one bottom status bar (`statusbar.ts`) via a single `[data-help]` delegation; the editor (`editor.ts`) feeds it directly. The editor overlay is a `<pre id="hl">` layered behind a transparent-text `<textarea>` — the two **must** share every CSS metric (font, padding, `white-space`, `tab-size`) or the colors drift off the characters. Guided learning (`tour.ts` engine + `tutorials.ts` content) drives the real studio through a small `TourCtx` and rewrites the canonical text exactly like the toolbar — lesson steps validate against the live `store.run`.

## Reference

The original single-file prototype is preserved at `reference/flowloom-v1.html` (compiled expressions with `new Function`; superseded by the AST engine).
