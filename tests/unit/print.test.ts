import { describe, it, expect } from "vitest";
import { parseModel, printModel } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// CONTRACT: printing a model and re-parsing it yields the same model. Formatting
// is normalised — that is what `fmt` is for — but nothing about the meaning may
// change. The strongest form of the check is the one that matters to a user:
// the reprinted model produces the same numbers.

/** The parts of a Model that carry meaning, in a comparable shape. */
const shape = (src: string) => {
  const m = parseModel(src);
  return {
    dims: [...m.dims.values()].map((d) => `${d.name}=${d.elements.join(",")}`),
    stocks: m.stocks.map((s) => `${s.name}|${s.unit ?? ""}|${s.dims?.join(",") ?? ""}|${s.nonNegative ? ">=0" : ""}`),
    rates: [...m.rates.keys()].sort(),
    vars: m.vars
      .map((v) => `${v.kind}|${v.name}|${v.unit ?? ""}|${v.constant ? "const" : ""}|${v.boolean ? "sw" : ""}|${v.data ? "data" : ""}|${v.rung ?? ""}|${JSON.stringify(v.range ?? null)}`)
      .sort(),
    tables: [...m.tables.keys()].sort(),
    links: m.links.map((l) => `${l.from}->${l.to}:${l.sign}`).sort(),
    scenarios: [...m.scenarios.values()].map((s) => `${s.name}:${s.sets.map((b) => `${b.key}=${b.value}`).join(",")}`).sort(),
    expects: m.expects.map((e) => `${e.scenario ?? ""}|${e.metric}|${e.op}|${e.value}|${JSON.stringify(e.tol ?? null)}`).sort(),
    settings: m.settings,
    plot: m.plot,
  };
};

/** Structural equality ignoring the `sim` line's source location. */
const meaning = (src: string) => {
  const s = shape(src);
  const { loc: _loc, ...settings } = s.settings;
  return { ...s, settings };
};

describe("printModel round-trips every built-in example", () => {
  for (const ex of EXAMPLES) {
    it(`preserves the meaning of "${ex.name}"`, () => {
      const printed = printModel(parseModel(ex.source));
      expect(meaning(printed), ex.name).toEqual(meaning(ex.source));
    });

    it(`preserves the numbers of "${ex.name}"`, () => {
      const before = simulate(parseModel(ex.source));
      const after = simulate(parseModel(printModel(parseModel(ex.source))));
      expect(after.names, ex.name).toEqual(before.names);
      for (const n of before.names) {
        const a = before.series.get(n)!, b = after.series.get(n)!;
        expect(b.length, `${ex.name}:${n}`).toBe(a.length);
        for (let i = 0; i < a.length; i++) expect(b[i], `${ex.name}:${n}[${i}]`).toBe(a[i]!);
      }
    });
  }
});

describe("printModel is idempotent", () => {
  it("printing twice changes nothing", () => {
    for (const ex of EXAMPLES) {
      const once = printModel(parseModel(ex.source));
      expect(printModel(parseModel(once)), ex.name).toBe(once);
    }
  });
});

describe("printModel keeps the constructs a naive printer would lose", () => {
  const round = (src: string) => printModel(parseModel(src));

  it("re-sugars a data line instead of leaking the internal table", () => {
    const out = round("stock X = 1\ndata obs = (0, 5) (1, 7) (2, 9)\nchange(X) = obs\nsim dt=1 to=2");
    expect(out).toMatch(/^data obs = \(0, 5\) \(1, 7\) \(2, 9\)$/m);
    expect(out).not.toMatch(/#data/);
  });

  it("keeps `linear` on a data line that asked for it", () => {
    expect(round("stock X = 1\ndata obs = (0, 5) (2, 9) linear\nchange(X) = obs\nsim dt=1 to=2")).toMatch(/linear$/m);
  });

  it("keeps a stock's `>= 0` floor", () => {
    expect(round("stock Inv [u] >= 0 = 100\nchange(Inv) = -1\nsim dt=1 to=5")).toMatch(/^stock Inv \[u\] >= 0 = 100$/m);
  });

  it("keeps a declared range in both spellings", () => {
    const out = round("stock X = 1\nparam a = 3 ± 1\nparam b = 10 in 5..20\nparam c = 4 ± 25%\nchange(X) = a + b + c\nsim dt=1 to=5");
    expect(out).toMatch(/param a = 3 ± 1/);
    expect(out).toMatch(/param b = 10 in 5\.\.20/);
    expect(out).toMatch(/param c = 4 ± 25%/);
  });

  it("keeps switches as on/off, not 1/0", () => {
    const out = round("stock X = 1\nswitch on1 = on\nswitch off1 = off\nchange(X) = on1 + off1\nsim dt=1 to=5");
    expect(out).toMatch(/switch on1 = on/);
    expect(out).toMatch(/switch off1 = off/);
  });

  it("keeps a `# @rung N` tag and its doc comment", () => {
    const out = round("stock X = 1\nparam lever = 2   # @rung 4 the price lever\nchange(X) = lever\nsim dt=1 to=5");
    expect(out).toMatch(/# @rung 4 the price lever/);
  });

  it("keeps subscripts, per-element values and the change() target", () => {
    const src = "dim r = North, South\nstock Pop[r] = 10, 20\nparam k[r] = 1, 2\nchange(Pop[r]) = k[r]\nsim dt=1 to=3";
    const out = round(src);
    expect(out).toMatch(/stock Pop\[r\] = 10, 20/);
    expect(out).toMatch(/change\(Pop\[r\]\) = k\[r\]/);
    expect(meaning(out)).toEqual(meaning(src));
  });

  it("carries `# @pos` layout through, but only when given the source", () => {
    // The one comment the toolchain writes rather than reads: the visual builder
    // stores node positions there. A formatter that dropped them would silently
    // throw away a diagram someone arranged by hand.
    const src = "stock X = 1\nparam k = 2\nchange(X) = k\n# @pos X 100 200\n# @pos k 50 80\nsim dt=1 to=5";
    const m = parseModel(src);
    expect(printModel(m, src)).toMatch(/# @pos X 100 200\n# @pos k 50 80/);
    expect(printModel(m)).not.toMatch(/@pos/);
  });

  it("drops a position for a name the model no longer declares", () => {
    const src = "stock X = 1\nchange(X) = 1\n# @pos X 10 20\n# @pos gone 30 40\nsim dt=1 to=5";
    const out = printModel(parseModel(src), src);
    expect(out).toMatch(/# @pos X 10 20/);
    expect(out).not.toMatch(/gone/);
  });

  it("stays idempotent with layout comments present", () => {
    const src = "stock X = 1\nparam k = 2\nchange(X) = k\n# @pos X 100 200\nsim dt=1 to=5";
    const once = printModel(parseModel(src), src);
    expect(printModel(parseModel(once), once)).toBe(once);
  });

  it("keeps whole-line comments where they were written", () => {
    // Section headers and explanations are not part of the Model, so a printer
    // that only renders the Model deletes them — and `fmt --write` would delete
    // them from the user's file.
    const src = "# ── Population sector ──\n# births outrun deaths\nstock P = 5\nparam r = 0.7   # per year\nchange(P) = r * P\nsim dt=1 to=20";
    const out = printModel(parseModel(src), src);
    expect(out).toMatch(/^# ── Population sector ──$/m);
    expect(out).toMatch(/^# births outrun deaths$/m);
    expect(out).toMatch(/param r = 0\.7 {3}# per year/); // and the attached one is not duplicated
    expect(out.match(/per year/g)).toHaveLength(1);
  });

  it("never emits two blank lines in a row, even after dropping a stale hint", () => {
    const src = "stock X = 1\nchange(X) = 1\n\n# @pos gone 1 2\n\nsim dt=1 to=5";
    expect(printModel(parseModel(src), src)).not.toMatch(/\n\n\n/);
  });

  it("prints a percentage tolerance without float dust", () => {
    // `± 7%` is stored as 0.07; `× 100` gives 7.000000000000001, which would make
    // `fmt` rewrite an already-formatted file and fail forever as a CI gate.
    for (const pct of [7, 25, 29, 3.5]) {
      const src = `stock X = 1\nparam a = 3 ± ${pct}%\nchange(X) = a\nexpect final:X == 3 ± ${pct}%\nsim dt=1 to=5`;
      const once = printModel(parseModel(src), src);
      expect(once, `${pct}%`).toMatch(new RegExp(`± ${String(pct).replace(".", "\\.")}%`));
      expect(printModel(parseModel(once), once), `${pct}% idempotent`).toBe(once);
    }
  });

  it("keeps links, scenarios and expects", () => {
    const src = [
      "stock Cash = 100",
      "param burn = 10   # monthly",
      "change(Cash) = -burn",
      "link burn -> Cash -",
      "scenario lean burn=5",
      "expect final:Cash > -500",
      "expect lean final:Cash == 40 ± 1%",
      "sim dt=1 to=12 method=map seed=3",
      "plot Cash",
    ].join("\n");
    expect(meaning(round(src))).toEqual(meaning(src));
  });
});
