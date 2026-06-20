import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { monteCarlo } from "../../src/engine/index.js";

const WALK = `
stock Walk = 0
flow shock = random_normal(0, 1)
d(Walk) = shock
sim dt=1 to=30 method=rk4
plot Walk`;

describe("monteCarlo", () => {
  it("produces monotonic percentile bands", async () => {
    const r = await monteCarlo(parseModel(WALK), { runs: 100, seed: 1 });
    const b = r.bands.get("Walk")!;
    expect(r.runs).toBe(100);
    expect(b.p50.length).toBe(r.t.length);
    for (let i = 0; i < r.t.length; i++) {
      expect(b.p05[i]!).toBeLessThanOrEqual(b.p25[i]!);
      expect(b.p25[i]!).toBeLessThanOrEqual(b.p50[i]!);
      expect(b.p50[i]!).toBeLessThanOrEqual(b.p75[i]!);
      expect(b.p75[i]!).toBeLessThanOrEqual(b.p95[i]!);
    }
  });

  it("is reproducible for a fixed base seed", async () => {
    const a = await monteCarlo(parseModel(WALK), { runs: 20, seed: 7 });
    const b = await monteCarlo(parseModel(WALK), { runs: 20, seed: 7 });
    expect(b.bands.get("Walk")!.p50).toEqual(a.bands.get("Walk")!.p50);
  });

  it("spreads out over time for a random walk", async () => {
    const r = await monteCarlo(parseModel(WALK), { runs: 200, seed: 3 });
    const b = r.bands.get("Walk")!;
    const spread = (i: number) => b.p95[i]! - b.p05[i]!;
    // The band starts at zero width (Walk=0 for all) and widens as shocks accumulate.
    expect(spread(0)).toBeCloseTo(0, 9);
    expect(spread(r.t.length - 1)).toBeGreaterThan(spread(1));
  });

  it("defaults the series set to the plot line", async () => {
    const r = await monteCarlo(parseModel(WALK), { runs: 5, seed: 1 });
    expect(r.series).toEqual(["Walk"]);
  });
});
