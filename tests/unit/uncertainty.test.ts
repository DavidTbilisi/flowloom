import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { paramRanges, monteCarlo, calibrate, globalSensitivity, lintModel, parseDataset } from "../../src/engine/index.js";

// CONTRACT: one declaration, three readers. `param x = 0.03 ± 0.01` is the
// modeller saying how well a knob is known — and before it existed, each of
// monteCarlo (seed only), globalSensitivity (a made-up ±frac box) and calibrate
// (no bounds at all) had its own answer and no way to be told the real one.

const RANGED = `stock Population = 5
param birthRate = 0.03 ± 0.01
param carrying = 1000 in 800..1400
param mortality = 0.01 ± 20%
flow growth = birthRate * Population * (1 - Population / carrying)
flow deaths = mortality * Population
change(Population) = growth - deaths
sim dt=0.5 to=60
plot Population`;

describe("parsing and resolving a declared range", () => {
  it("resolves ±, ±%, and explicit bounds to numbers", () => {
    const r = paramRanges(parseModel(RANGED));
    const birth = r.get("birthRate")!;
    expect(birth.lo).toBeCloseTo(0.02, 12);
    expect(birth.hi).toBeCloseTo(0.04, 12);
    expect(birth.explicit).toBe(false);
    expect(r.get("carrying")).toMatchObject({ lo: 800, hi: 1400, explicit: true });
    // a percentage is of the value itself
    const m = r.get("mortality")!;
    expect(m.lo).toBeCloseTo(0.008, 12);
    expect(m.hi).toBeCloseTo(0.012, 12);
  });

  it("leaves an undeclared param out of the map", () => {
    const r = paramRanges(parseModel("stock X = 1\nparam k = 2\nchange(X) = k\nsim dt=1 to=5"));
    expect(r.size).toBe(0);
  });

  it("resolves a tolerance against a computed value, not just a literal", () => {
    const r = paramRanges(parseModel("stock X = 1\nparam base = 10\nparam k = base * 2 ± 10%\nchange(X) = k\nsim dt=1 to=5"));
    expect(r.get("k")).toMatchObject({ base: 20, lo: 18, hi: 22 });
  });

  it("rejects a range where it cannot mean anything, naming the alternative", () => {
    expect(() => parseModel("stock X = 1\nconst c = 5 ± 1\nchange(X) = c\nsim dt=1 to=5")).toThrow(/use `param` if it should vary/);
    expect(() => parseModel("stock X = 1\naux a = 5 ± 1\nchange(X) = a\nsim dt=1 to=5")).toThrow(/a is computed from other values/);
    expect(() => parseModel("stock X = 1\nparam c = 5 in 9..2\nchange(X) = c\nsim dt=1 to=5")).toThrow(/needs lo < hi/);
  });

  it("does not silently reinterpret `+-`, which is already subtraction", () => {
    const m = parseModel("stock X = 1\nparam c = 5 +- 1\nchange(X) = c\nsim dt=1 to=5");
    expect(m.varIndex.get("c")!.range).toBeUndefined();
    expect(m.diagnostics.some((d) => /'\+-' is subtraction here/.test(d.message))).toBe(true);
  });

  it("lints a param sitting outside its own declared range", () => {
    const msgs = lintModel(parseModel("stock X = 1\nparam r = 9 in 1..5\nchange(X) = r\nsim dt=1 to=5")).map((d) => d.message);
    expect(msgs.join(" ")).toMatch(/param 'r' is 9 but declares the range 1\.\.5/);
  });
});

describe("monteCarlo samples the declared ranges", () => {
  it("gives a deterministic model a real spread — the case that used to be flat", async () => {
    const r = await monteCarlo(parseModel(RANGED), { runs: 60 });
    expect(r.sampled.map((p) => p.name).sort()).toEqual(["birthRate", "carrying", "mortality"]);
    const b = r.bands.get("Population")!;
    const last = b.p05.length - 1;
    expect(b.p95[last]! - b.p05[last]!).toBeGreaterThan(0);
  });

  it("says nothing varied when nothing declares a range", async () => {
    const r = await monteCarlo(parseModel("stock X = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=1 to=20\nplot X"), { runs: 20 });
    expect(r.sampled).toEqual([]);
    const b = r.bands.get("X")!;
    expect(b.p95.at(-1)).toBe(b.p05.at(-1)); // flat, honestly so
  });

  it("is reproducible: the same seed gives the same bands", async () => {
    const model = parseModel(RANGED);
    const a = await monteCarlo(model, { runs: 20, seed: 7 });
    const b = await monteCarlo(model, { runs: 20, seed: 7 });
    expect(b.bands.get("Population")!.p50).toEqual(a.bands.get("Population")!.p50);
    const c = await monteCarlo(model, { runs: 20, seed: 8 });
    expect(c.bands.get("Population")!.p50).not.toEqual(a.bands.get("Population")!.p50);
  });

  it("samples each param once per run, not once per step", async () => {
    // A once-per-run draw keeps every run a clean exponential; a per-step draw
    // (what `param k = random_normal(...)` would give) would not.
    const r = await monteCarlo(parseModel("stock X = 100\nparam k = 0.1 ± 0.05\nchange(X) = -k * X\nsim dt=0.5 to=20\nplot X"), { runs: 40 });
    const b = r.bands.get("X")!;
    for (let i = 1; i < b.p50.length; i++) {
      expect(b.p05[i]!).toBeLessThanOrEqual(b.p05[i - 1]!); // every percentile decays monotonically
      expect(b.p95[i]!).toBeLessThanOrEqual(b.p95[i - 1]!);
    }
  });

  it("honours an explicit param subset, including none at all", async () => {
    const model = parseModel(RANGED);
    expect((await monteCarlo(model, { runs: 5, params: ["carrying"] })).sampled.map((p) => p.name)).toEqual(["carrying"]);
    expect((await monteCarlo(model, { runs: 5, params: [] })).sampled).toEqual([]);
  });
});

describe("globalSensitivity explores the declared range", () => {
  it("uses the declared bounds rather than a ±frac box", async () => {
    // `carrying` is declared 800..1400 around 1000 — far wider than the ±1% box
    // `frac` would otherwise impose, so its measured effect must reflect the
    // declared span rather than the fallback.
    const opts = { method: "morris" as const, metric: "final:Population", params: ["birthRate", "carrying"], frac: 0.01, samples: 6 };
    const declared = await globalSensitivity(parseModel(RANGED), opts);
    const undeclared = await globalSensitivity(
      parseModel(RANGED.replace(" in 800..1400", "")),
      opts,
    );
    const effect = (r: Awaited<ReturnType<typeof globalSensitivity>>) => r.rows.find((row) => row.param === "carrying")!.muStar!;
    expect(effect(declared)).toBeGreaterThan(0);
    // a 600-wide declared span moves the metric far more than a ±1% box does
    expect(effect(declared)).toBeGreaterThan(effect(undeclared));
  });

  it("never samples a time-grain knob outside its declared range", async () => {
    // `lag` is a delay_fixed length, so it is a time-grain knob: its interval
    // used to be widened by a step *symmetrically*, which turned `in 3..9`
    // (base 3) into -3..9 — negative pipeline lengths, in the very branch whose
    // job is to respect the declaration.
    const src = `stock X = 0
param lag = 3 in 3..9
param k = 1
aux delayed = delay_fixed(X + k, lag)
change(X) = k - 0.1 * delayed
sim dt=1 to=40
plot X`;
    const r = await globalSensitivity(parseModel(src), { method: "morris", metric: "final:X", params: ["lag"], samples: 4 });
    expect(r.explored).toEqual([{ param: "lag", lo: 3, hi: 9, declared: true }]);
  });

  it("falls back to a ±frac box only for a knob that declares nothing, and says which is which", async () => {
    const src = "stock X = 1\nparam declared = 10 in 5..40\nparam bare = 10\nchange(X) = declared + bare\nsim dt=1 to=10\nplot X";
    const r = await globalSensitivity(parseModel(src), { method: "morris", metric: "final:X", frac: 0.1, samples: 4 });
    const by = Object.fromEntries(r.explored.map((e) => [e.param, e]));
    expect(by.declared).toMatchObject({ lo: 5, hi: 40, declared: true });
    expect(by.bare).toMatchObject({ lo: 9, hi: 11, declared: false });
  });
});

describe("calibrate respects the declared bounds", () => {
  it("does not fit outside them, and says when it fitted to the edge", async () => {
    // Observations generated from rate ≈ 0.2, but the model declares 0.01..0.05:
    // an unbounded simplex walks straight to 0.2 and writes it into the text.
    const src = "stock Pop = 10\nparam rate = 0.02 in 0.01..0.05\nflow g = rate * Pop\nchange(Pop) = g\nsim dt=1 to=10\nplot Pop";
    const dataset = parseDataset("t,Pop\n0,10\n2,14.9\n4,22.3\n6,33.2\n8,49.5\n10,73.9");
    const r = await calibrate(parseModel(src), { params: ["rate"], dataset });
    expect(r.params.rate).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(r.params.rate).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(r.atBound).toEqual(["rate"]);
    expect(r.bounds!.rate).toEqual([0.01, 0.05]);

    const free = await calibrate(parseModel(src), { params: ["rate"], dataset, unbounded: true });
    expect(free.params.rate!).toBeGreaterThan(0.05);
    expect(free.atBound).toBeUndefined();
  });

  it("finds a value inside the bounds when the data allows one", async () => {
    const src = "stock Pop = 10\nparam rate = 0.02 in 0.01..0.2\nflow g = rate * Pop\nchange(Pop) = g\nsim dt=1 to=10\nplot Pop";
    const dataset = parseDataset("t,Pop\n0,10\n2,11.73\n4,13.77\n6,16.16\n8,18.96\n10,22.26");
    const r = await calibrate(parseModel(src), { params: ["rate"], dataset });
    expect(r.params.rate).toBeGreaterThan(0.06);
    expect(r.params.rate).toBeLessThan(0.1);
    expect(r.atBound).toBeUndefined();
  });
});
