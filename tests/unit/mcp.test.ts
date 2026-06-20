import { describe, it, expect } from "vitest";
import { handlers, INSTRUCTIONS, buildServer } from "../../src/mcp.js";

// Smoke test: exercise the MCP tool handlers in-process (no transport). They are
// thin wrappers over the engine, so we just assert the shapes agents will see.

const SRC = `stock Population = 5
param birthRate = 0.7
flow growth = birthRate * Population
d(Population) = growth
sim dt=0.1 to=10 method=rk4
plot Population`;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe("mcp handlers", () => {
  it("flow_check reports ok with counts", () => {
    const r = parse(handlers.flow_check({ model: SRC }));
    expect(r.ok).toBe(true);
    expect(r.stocks).toBe(1);
  });

  it("flow_check surfaces structured diagnostics on a bad model", () => {
    const r = parse(handlers.flow_check({ model: "flow x = undefinedThing" }));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toHaveProperty("line");
    expect(r.diagnostics[0]).toHaveProperty("message");
  });

  it("flow_check is trustworthy: a lint-level call error makes ok:false, not a buried error", () => {
    // unknown function / wrong arity parse fine but won't run. `check` must report
    // ok:false with structured diagnostics — an agent treats ok:true as "this runs".
    const badFn = parse(handlers.flow_check({ model: "stock S = 1\nd(S) = avg(1, 2)" }));
    expect(badFn.ok).toBe(false);
    expect(badFn.diagnostics[0]).toMatchObject({ line: 2 });
    expect(badFn.diagnostics[0].message).toMatch(/unknown function 'avg'/);

    const badArity = parse(handlers.flow_check({ model: "stock S = 1\nd(S) = clamp(S)" }));
    expect(badArity.ok).toBe(false);
    expect(badArity.diagnostics[0].message).toMatch(/clamp\(\) takes 3 arguments/);
  });

  it("flow_check includes lint warnings on an ok model", () => {
    const r = parse(handlers.flow_check({ model: "stock X = 1\nparam unused = 9\nd(X) = 1" }));
    expect(r.ok).toBe(true);
    expect(r.lint.some((d: { message: string }) => /never used/.test(d.message))).toBe(true);
  });

  it("flow_lint reports non-fatal warnings", () => {
    const r = parse(handlers.flow_lint({ model: "stock X = 1\nstock Frozen = 5\nd(X) = 1" }));
    expect(r.warnings.some((d: { message: string }) => /has no change\(Frozen\) rate/.test(d.message))).toBe(true);
  });

  it("flow_run returns t and the requested series", async () => {
    const r = parse(await handlers.flow_run({ model: SRC, plot: ["Population"] }));
    expect(r.t.length).toBeGreaterThan(1);
    expect(r.series.Population.length).toBe(r.t.length);
    expect(r.series.Population[0]).toBe(5);
  });

  it("flow_run downsamples a long run so the payload can't blow an agent's context", async () => {
    // 100k+ steps at full resolution would be megabytes of JSON; the run still
    // integrates at dt=0.01 but the returned arrays are capped.
    const long = `stock S = 100\nparam k = 0.05\nflow grow = k * S\nchange(S) = grow\nsim dt=0.01 to=1000\nplot S`;
    const r = parse(await handlers.flow_run({ model: long, plot: ["S"] }));
    expect(r.steps).toBeGreaterThan(50000);          // full-resolution integration reported
    expect(r.t.length).toBeLessThanOrEqual(1001);    // but a small payload returned
    expect(r.series.S.length).toBe(r.t.length);      // t and series stay aligned
    expect(r.sampled.of).toBe(r.steps);              // tells the agent it was downsampled
    expect(r.sampled.note).toMatch(/maxPoints|flow_summary/);
    // first and last samples are preserved (the endpoints an agent cares about)
    expect(r.series.S[0]).toBe(100);
    expect(r.series.S.at(-1)).toBeGreaterThan(100);  // k>0 ⇒ growth
  });

  it("flow_run honors maxPoints and returns short runs verbatim", async () => {
    const long = `stock S = 1\nparam k = 0.1\nchange(S) = k * S\nsim dt=0.01 to=1000`;
    const coarse = parse(await handlers.flow_run({ model: long, plot: ["S"], maxPoints: 50 }));
    expect(coarse.t.length).toBeLessThanOrEqual(51);
    // a short run is untouched — no downsampling, no `sampled` field
    const short = parse(await handlers.flow_run({ model: SRC, plot: ["Population"] }));
    expect(short).not.toHaveProperty("sampled");
    expect(short.t.length).toBe(short.steps);
  });

  it("flow_run honors a --set override", async () => {
    const base = parse(await handlers.flow_run({ model: SRC, plot: ["Population"] }));
    const set = parse(await handlers.flow_run({ model: SRC, plot: ["Population"], set: ["Population=50"] }));
    expect(set.series.Population[0]).toBe(50);
    expect(set.series.Population[0]).not.toBe(base.series.Population[0]);
  });

  it("flow_summary classifies each series instead of dumping arrays", async () => {
    const r = parse(await handlers.flow_summary({ model: SRC, plot: ["Population"] }));
    expect(r.series[0].name).toBe("Population");
    expect(r.series[0].behavior).toBe("growth");
    expect(r.series[0]).not.toHaveProperty("t");
  });

  it("flow_sweep returns a response curve of one knob", async () => {
    const r = parse(await handlers.flow_sweep({ model: SRC, param: "birthRate", from: 0.1, to: 0.5, steps: 3, metric: "final:Population" }));
    expect(r.points).toHaveLength(3);
    expect(r.points[0].value).toBeCloseTo(0.1, 9);
    // higher growth rate ⇒ larger final population
    expect(r.points[2].metric).toBeGreaterThan(r.points[0].metric);
  });

  it("flow_sensitivity ranks params", async () => {
    const r = parse(await handlers.flow_sensitivity({ model: SRC, metric: "final:Population" }));
    expect(r.rows[0].param).toBe("birthRate");
    expect(r.rows[0]).toHaveProperty("delta");
  });

  it("flow_sensitivity runs global methods (morris/sobol)", async () => {
    const morris = parse(await handlers.flow_sensitivity({ model: SRC, metric: "final:Population", method: "morris", samples: 6 }));
    expect(morris.method).toBe("morris");
    expect(morris.rows[0]).toHaveProperty("muStar");
    const sobol = parse(await handlers.flow_sensitivity({ model: SRC, metric: "final:Population", method: "sobol", samples: 32 }));
    expect(sobol.method).toBe("sobol");
    expect(sobol.rows[0]).toHaveProperty("st");
  });

  it("flow_solve finds the knob value that hits a target", async () => {
    // final:Population grows with birthRate; solve for a reachable target.
    const r = parse(await handlers.flow_solve({ model: SRC, param: "birthRate", metric: "final:Population", target: 20 }));
    expect(r.converged).toBe(true);
    expect(r.achieved).toBeCloseTo(20, 2);
    expect(r).toHaveProperty("value");
  });

  it("flow_montecarlo returns percentile bands for a stochastic model", async () => {
    const src = `stock Walk = 0
flow shock = random_normal(0, 1)
d(Walk) = shock
sim dt=1 to=20 method=rk4 seed=1
plot Walk`;
    const r = parse(await handlers.flow_montecarlo({ model: src, runs: 50, seed: 1 }));
    expect(r.runs).toBe(50);
    const walk = r.series.find((s: { name: string }) => s.name === "Walk");
    expect(walk.final.p05).toBeLessThanOrEqual(walk.final.p50);
    expect(walk.final.p50).toBeLessThanOrEqual(walk.final.p95);
    expect(walk.trajectory.t[0]).toBe(0);
  });

  it("flow_calibrate fits a param to observed data", async () => {
    const data = "t,Population\n0,5\n2,8\n4,12\n6,17";
    const r = parse(await handlers.flow_calibrate({ model: SRC, params: ["birthRate"], data, map: { Population: "Population" } }));
    expect(r).toHaveProperty("params");
    expect(r.params).toHaveProperty("birthRate");
    expect(r.perSeries.Population).toBeLessThan(1);
  });

  it("flow_describe returns the model structure", () => {
    const r = parse(handlers.flow_describe({ model: SRC }));
    expect(r.stocks[0].name).toBe("Population");
    expect(r.rates[0]).toEqual({ stock: "Population", expr: "growth" });
  });

  it("flow_explain returns prose", () => {
    const r = handlers.flow_explain({ model: SRC });
    expect(r.content[0]!.text).toMatch(/feedback loop/);
  });

  it("flow_examples lists then fetches by name", () => {
    const list = parse(handlers.flow_examples({}));
    expect(Array.isArray(list)).toBe(true);
    const one = parse(handlers.flow_examples({ name: list[0].name }));
    expect(one.source).toBeTruthy();
  });
});

describe("agent orientation", () => {
  // The server-level instructions are the first thing an agent reads on connect.
  // Pin that they hand over the authoring loop rather than leaving 14 flat tools
  // to be discovered by trial and error.
  it("instructions name the check-first loop, the reference, and the canonical-text idea", () => {
    expect(INSTRUCTIONS).toMatch(/flow:\/\/reference/); // points at the grammar
    expect(INSTRUCTIONS).toMatch(/flow_check/);         // validate before running
    expect(INSTRUCTIONS).toMatch(/flow_summary/);       // prefer the classified read
    expect(INSTRUCTIONS).toMatch(/canonical/i);         // the core mental model
  });

  it("the built server carries the instructions to the client", () => {
    // buildServer() must wire INSTRUCTIONS into the McpServer, not drop them.
    const server = buildServer();
    expect((server.server as unknown as { _instructions?: string })._instructions).toBe(INSTRUCTIONS);
  });
});

describe("agent journey: cold build → error → fix → run", () => {
  // The recoverable loop an agent actually walks. Each step's output must enable
  // the next, ending in a usable run — no dead ends.
  it("a check failure carries a recovery hint, and the fixed model runs", async () => {
    // forgot to define `rate` — a classic LLM omission with no near-miss neighbour
    const broken = `stock S = 1\nd(S) = rate * S\nsim dt=0.1 to=5`;
    const bad = parse(handlers.flow_check({ model: broken }));
    expect(bad.ok).toBe(false);
    // the diagnostic names the offending symbol with a line, so the agent knows
    // exactly what to fix (not just that something failed)
    expect(bad.diagnostics[0]).toHaveProperty("line");
    expect(bad.diagnostics[0].message).toMatch(/unknown name 'rate'/);

    // apply the obvious fix the message implies
    const fixed = `param rate = 0.5\n${broken}`;
    expect(parse(handlers.flow_check({ model: fixed })).ok).toBe(true);

    // and the fixed model actually produces a series
    const run = parse(await handlers.flow_run({ model: fixed, plot: ["S"] }));
    expect(run.series.S.length).toBe(run.steps);
    expect(run.series.S.at(-1)).toBeGreaterThan(1); // rate>0 ⇒ growth
  });
});
