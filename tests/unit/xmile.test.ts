import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseModel } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { importXmile } from "../../src/interop/xmile.js";
import { parseXml, findAll, childText } from "../../src/interop/xml.js";

// CONTRACT: an XMILE file comes in as a model that runs, or as a model plus a
// note saying exactly what to fix. It never throws away a translation it managed
// to make, and it never silently changes what the model means.

const fixture = readFileSync(new URL("../fixtures/sir.stmx", import.meta.url), "utf8");

describe("the XML reader", () => {
  it("reads elements, attributes, text and namespaces", () => {
    const doc = parseXml('<a:root x="1"><b:kid y="2">hi</b:kid></a:root>');
    const root = doc.children[0]!;
    expect(root.name).toBe("root");
    expect(root.attrs.x).toBe("1");
    expect(root.children[0]!.name).toBe("kid");
    expect(root.children[0]!.text).toBe("hi");
  });

  it("handles CDATA, comments, entities and self-closing tags", () => {
    const doc = parseXml('<r><!-- skip --><e><![CDATA[a < b]]></e><f>x &amp; y &#65;</f><g/></r>');
    const r = doc.children[0]!;
    expect(childText(r, "e")).toBe("a < b");
    expect(childText(r, "f")).toBe("x & y A");
    expect(findAll(r, "g")).toHaveLength(1);
  });

  it("is not fooled by a > inside an attribute value", () => {
    const doc = parseXml('<r><e eqn="a > b">t</e></r>');
    expect(doc.children[0]!.children[0]!.attrs.eqn).toBe("a > b");
  });
});

describe("importXmile", () => {
  const imported = importXmile(fixture);

  it("produces a model that parses, checks and runs", () => {
    const m = parseModel(imported.model);
    expect(m.stocks.map((s) => s.name)).toEqual(["Susceptible", "Infected", "Recovered"]);
    expect(simulate(m).t.length).toBeGreaterThan(1);
  });

  it("turns inflows and outflows into one change() per stock", () => {
    expect(imported.model).toMatch(/change\(Susceptible\) = -Infection/);
    expect(imported.model).toMatch(/change\(Infected\) = Infection - Recovery/);
  });

  it("normalises names with spaces, in declarations and in equations", () => {
    expect(imported.model).toMatch(/aux Total_Population = /);
    expect(imported.model).toMatch(/Beta \* Susceptible \* Infected \/ Total_Population/);
  });

  it("reads a bare-number aux as a param, so it gets a slider and sensitivity", () => {
    expect(imported.model).toMatch(/^param Beta = 0\.4/m);
    expect(imported.model).toMatch(/^aux Total_Population/m); // and a computed one stays an aux
  });

  it("translates IF/THEN/ELSE and XMILE's comparison spellings", () => {
    expect(imported.model).toMatch(/if\(Infected > 100, 0\.2, 0\.4\)/);
  });

  it("carries units, docs, non_negative, graphical functions and sim specs", () => {
    expect(imported.model).toMatch(/stock Susceptible \[people\] = 999/);
    expect(imported.model).toMatch(/# Everyone who can still catch it/);
    expect(imported.model).toMatch(/stock Infected \[people\] >= 0 = 1/);
    expect(imported.model).toMatch(/table Seasonality = \(0, 1\) \(30, 1\.4\) \(60, 1\) \(90, 0\.7\)/);
    expect(imported.model).toMatch(/sim dt=0\.25 to=120 method=rk4 timeunit=Days/);
  });

  it("reproduces the hand-written model's numbers", () => {
    // The same epidemic, written twice: if the import means what it says, the
    // trajectories are the same to the last digit.
    const mine = simulate(parseModel(readFileSync(new URL("../../examples/sir-epidemic.flow", import.meta.url), "utf8")));
    const theirs = simulate(parseModel(imported.model));
    const a = mine.series.get("I")!, b = theirs.series.get("Infected")!;
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 9);
  });
});

describe("importXmile reports what it could not bring across", () => {
  const wrap = (vars: string, specs = "<sim_specs><start>0</start><stop>10</stop><dt>1</dt></sim_specs>") =>
    `<xmile><model><variables>${vars}</variables></model>${specs}</xmile>`;

  const STOCK = '<stock name="S"><eqn>1</eqn><inflow>f</inflow></stock><flow name="f"><eqn>1</eqn></flow>';

  it("notes Euler and points at the numerics check", () => {
    expect(importXmile(wrap(STOCK)).notes.join(" ")).toMatch(/check --numerics/);
  });

  it("notes an unsupported function instead of guessing at one", () => {
    const r = importXmile(wrap('<stock name="S"><eqn>1</eqn><inflow>f</inflow></stock><flow name="f"><eqn>FORECAST(S, 3, 1)</eqn></flow>'));
    expect(r.notes.join(" ")).toMatch(/no flowloom equivalent for: FORECAST/);
    // and it still hands back the translation it managed, rather than nothing
    expect(r.model).toMatch(/stock S/);
  });

  it("notes a flattened array rather than dropping the stock", () => {
    const r = importXmile(wrap('<stock name="Pop" dimensions="region"><eqn>1</eqn><inflow>f</inflow></stock><flow name="f"><eqn>1</eqn></flow>'));
    expect(r.notes.join(" ")).toMatch(/subscripted in XMILE; imported as a scalar/);
    expect(r.model).toMatch(/stock Pop/);
  });

  it("notes a model with no stocks instead of pretending it will run", () => {
    expect(importXmile(wrap('<aux name="a"><eqn>1</eqn></aux>')).notes.join(" ")).toMatch(/needs at least one stock/);
  });

  it("reports two XMILE names that are actually the same name, rather than merging them", () => {
    // "Total Pop" and "Total_Pop" are one name by the XMILE spec; a file with
    // both is malformed, and silently collapsing two variables into one is
    // exactly the kind of quiet wrongness an importer must not produce.
    const r = importXmile(wrap('<stock name="Total Pop"><eqn>1</eqn><inflow>f</inflow></stock><aux name="Total_Pop"><eqn>2</eqn></aux><flow name="f"><eqn>1</eqn></flow>'));
    expect(r.notes.join(" ")).toMatch(/are the same name in XMILE/);
  });

  it("never truncates an undeclared name that starts with a declared one", () => {
    // `Total Population` is declared; `Total Population Growth` is not. Matching
    // by prefix would turn the second into the first and silently drop " Growth",
    // producing a model that parses and means something else.
    const r = importXmile(wrap(
      '<stock name="S"><eqn>1</eqn><inflow>f</inflow></stock>'
      + '<flow name="f"><eqn>Total Population Growth</eqn></flow>'
      + '<aux name="Total Population"><eqn>7</eqn></aux>',
    ));
    expect(r.model).not.toMatch(/=\s*Total_Population\s*$/m);
    expect(r.notes.join(" ")).toMatch(/does not parse yet/);
  });

  it("maps a declared multi-word name wherever it is spelled with spaces or underscores", () => {
    const r = importXmile(wrap(
      '<stock name="S"><eqn>1</eqn><inflow>f</inflow></stock>'
      + '<flow name="f"><eqn>Total_Population * 2</eqn></flow>'
      + '<aux name="Total Population"><eqn>7</eqn></aux>',
    ));
    expect(r.model).toMatch(/flow f = Total_Population \* 2/);
  });

  it("imports an INLINE graphical function as a real lookup, not the identity", () => {
    // The standard Stella shape: a <gf> inside an aux, with no name attribute,
    // whose input is the parent's own <eqn>. Dropping it leaves `aux effect =
    // ratio` — a model that runs and is confidently wrong.
    const r = importXmile(wrap(
      '<stock name="C"><eqn>100</eqn><inflow>f</inflow></stock><flow name="f"><eqn>effect</eqn></flow>'
      + '<aux name="ratio"><eqn>C / 200</eqn></aux>'
      + '<aux name="effect"><eqn>ratio</eqn><gf><xpts>0,0.5,1</xpts><ypts>1,0.6,0</ypts></gf></aux>',
    ));
    expect(r.model).toMatch(/table effect_lookup = \(0, 1\) \(0\.5, 0\.6\) \(1, 0\)/);
    expect(r.model).toMatch(/aux effect = effect_lookup\(ratio\)/);
    expect(parseModel(r.model).tables.has("effect_lookup")).toBe(true);
  });

  it("says so when an inline graphical function has unusable points", () => {
    const r = importXmile(wrap(
      '<stock name="C"><eqn>1</eqn><inflow>f</inflow></stock><flow name="f"><eqn>1</eqn></flow>'
      + '<aux name="effect"><eqn>2</eqn><gf><xpts></xpts><ypts></ypts></gf></aux>',
    ));
    expect(r.notes.join(" ")).toMatch(/NOT the same curve/);
  });

  it("does not call a value fed through a lookup a knob", () => {
    // `param` means "a constant with a slider"; a lookup call is a computation.
    const r = importXmile(wrap(
      '<stock name="C"><eqn>1</eqn><inflow>f</inflow></stock><flow name="f"><eqn>1</eqn></flow>'
      + '<aux name="effect"><eqn>0.5</eqn><gf><xpts>0,1</xpts><ypts>2,3</ypts></gf></aux>',
    ));
    expect(r.model).toMatch(/aux effect = effect_lookup\(0\.5\)/);
  });

  it("refuses a document that is not XMILE at all", () => {
    expect(() => importXmile("<html><body>nope</body></html>")).toThrow(/is this an XMILE/);
    expect(() => importXmile("{ not xml }")).toThrow();
  });
});
