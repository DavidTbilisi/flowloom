import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { analyzeLoops } from "../../src/engine/index.js";

// Loop-polarity is a core systems-thinking claim the tool makes. Pin it.

function loops(src: string) {
  return analyzeLoops(parseModel(src));
}

describe("feedback loop detection", () => {
  it("labels a single self-reinforcing loop R", () => {
    // dN/dt = r·N ⇒ N → N positive self-loop ⇒ reinforcing
    const r = loops(`stock N = 1\nparam r = 1\nd(N) = r*N\nsim to=5`);
    expect(r.counts.R).toBe(1);
    expect(r.counts.B).toBe(0);
  });

  it("labels a goal-seeking loop B", () => {
    // cooling: dTemp/dt = -k(Temp-room); raising Temp lowers the rate ⇒ balancing
    const r = loops(`stock Temp = 90\nparam room = 20\nparam k = 0.3\nflow cooling = k*(Temp-room)\nd(Temp) = -cooling\nsim to=5`);
    expect(r.counts.B).toBe(1);
    expect(r.counts.R).toBe(0);
  });

  it("logistic growth has one structural loop, reinforcing at low population", () => {
    const r = loops(
      `stock Population = 5\nparam birthRate = 0.7\nparam carrying = 1000\nflow growth = birthRate*Population*(1 - Population/carrying)\nd(Population) = growth\nsim to=25`,
    );
    // One cycle: Population → growth → Population. Near P=5 it is reinforcing;
    // the balancing brake is the SAME nonlinear flow tightening as P→carrying,
    // not a separate structural loop. (Polarity is read at t=start.)
    expect(r.loops.length).toBe(1);
    expect(r.counts.R).toBe(1);
  });

  it("reports no loops for an open-loop model", () => {
    const r = loops(`stock X = 0\nparam c = 1\nflow f = c\nd(X) = f\nsim to=5`);
    expect(r.loops.length).toBe(0);
  });

  it("terminates quickly on a dense graph (bounded cycle search)", () => {
    // A densely cross-coupled ring has astronomically many simple cycles; the
    // DFS is bounded by a traversal budget so analysis can't hang the UI.
    const N = 16, reach = 5;
    const L: string[] = [];
    for (let i = 0; i < N; i++) L.push(`stock N${i} = ${10 + i}`);
    L.push("param k = 0.05");
    for (let i = 0; i < N; i++) {
      const terms: string[] = [];
      for (let d = 1; d <= reach; d++) {
        terms.push(`(N${(i + d) % N} - N${i})`);
        terms.push(`(N${(i - d + N) % N} - N${i})`);
      }
      L.push(`flow d${i} = k * (${terms.join(" + ")})`);
      L.push(`d(N${i}) = d${i}`);
    }
    L.push("sim to=5");
    const t0 = Date.now();
    const r = analyzeLoops(parseModel(L.join("\n")));
    expect(Date.now() - t0).toBeLessThan(5000); // bounded, not exponential
    expect(r.capped).toBe(true);
    expect(r.loops.length).toBeGreaterThan(0);
  });
});
