import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// CONTRACT: the CLI's exit codes. `check`, `test` and `diff` are meant to sit in
// someone's CI — a model that stops parsing, an `expect` line that starts
// failing, or a refactor that moves the numbers has to fail the build, not print
// a warning and exit 0.
//
// These run the *built* binary rather than importing the module, for two
// reasons: src/cli.ts calls main() at load, and dist-cli/ is what people
// actually install — a NodeNext build whose `.js` import extensions have to
// resolve at runtime with no bundler. That resolution is exactly what breaks
// silently, so the test exercises it.

const root = fileURLToPath(new URL("../..", import.meta.url));
const bin = `${root}dist-cli/cli.js`;

const run = (...args: string[]) => runWith("", ...args);

/** Run the built binary, optionally feeding a model on stdin (`-`). */
const runWith = (stdin: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", input: stdin });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

beforeAll(() => {
  if (existsSync(bin)) return;
  const r = spawnSync("npm", ["run", "build:cli"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build:cli failed:\n${r.stderr}`);
}, 120_000);

describe("flowloom CLI — the exit-code contract", () => {
  it("check succeeds on a valid model", () => {
    const r = run("check", "examples/sir-epidemic.flow");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok: 3 stocks/);
  });

  it("check fails on a parse error, naming the line and the fix", () => {
    const r = runWith("stock S = 1\nchange(S) = rate * S\nsim dt=0.1 to=5", "check", "-");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/line 2/);
    expect(r.err).toMatch(/unknown name 'rate'/);
  });

  it("check fails on a call that parses but would not run", () => {
    const r = runWith("stock S = 1\nchange(S) = clamp(S)\nsim dt=1 to=5", "check", "-");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/clamp\(\) takes 3 arguments/);
  });

  it("check --numerics fails when the answer does not survive a smaller step", () => {
    expect(run("check", "stress/11-stiff-blowup.flow", "--numerics").code).toBe(1);
    expect(run("check", "examples/logistic-growth.flow", "--numerics").code).toBe(0);
  });

  it("test passes the model's own expect lines, and fails when one breaks", () => {
    const model = "examples/family-budget-meadows-ladder.flow";
    expect(run("test", model).code).toBe(0);
    // move a knob the expectations depend on: the claims must stop holding
    const broken = run("test", model, "--set", "income=1");
    expect(broken.code).toBe(1);
    expect(broken.out + broken.err).toMatch(/failed/);
  });

  it("diff exits non-zero when an edit moves the numbers, and zero when it doesn't", () => {
    expect(run("diff", "examples/logistic-growth.flow", "examples/logistic-growth.flow").code).toBe(0);
    expect(run("diff", "examples/logistic-growth.flow", "examples/sir-epidemic.flow").code).toBe(1);
  });

  it("reports its version, and it is the package's", async () => {
    const { VERSION } = await import("../../src/version.js");
    expect(run("--version").out.trim()).toBe(VERSION);
  });

  it("an unknown command fails with a pointer to --help", () => {
    const r = run("frobnicate", "examples/sir-epidemic.flow");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--help/);
  });
});

describe("flowloom CLI — fmt and import", () => {
  it("fmt exits non-zero on an unformatted file and zero on its own output", () => {
    const first = run("fmt", "examples/sir-epidemic.flow");
    expect(first.code).toBe(1); // the hand-written file aligns `=`; fmt does not
    const second = runWith(first.out, "fmt", "-");
    expect(second.code).toBe(0);
    expect(second.out).toBe(first.out);
  });

  it("fmt refuses a model with include lines instead of inlining them over the file", () => {
    // `fmt --write` used to parse the *bundled* text and write that back, so the
    // include lines were replaced by the flat text they stand for — permanently.
    const r = run("fmt", "tests/fixtures/with-include.flow", "--write");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/format the parts instead/);
    // and the file is untouched
    expect(readFileSync(`${root}tests/fixtures/with-include.flow`, "utf8")).toMatch(/^include "/m);
  });

  it("fmt refuses a model that does not parse, and does not print a half-model", () => {
    const r = runWith("stock S = 1\nchange(S) = rate\nsim dt=1 to=5", "fmt", "-");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/unknown name 'rate'/);
  });

  it("import turns an XMILE file into a model that checks, silently when nothing was lost", () => {
    const r = run("import", "tests/fixtures/sir.stmx");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^stock Susceptible \[people\] = 999/m);
    expect(r.err).toBe(""); // a clean import says nothing — there is nothing to say
    expect(runWith(r.out, "check", "-").code).toBe(0);
  });

  it("import puts its notes on stderr, so `import x.stmx > y.flow` still reports them", () => {
    // no method attribute ⇒ Euler, which XMILE defaults to and flowloom warns about
    const xml = '<xmile><model><variables><stock name="S"><eqn>1</eqn><inflow>f</inflow></stock>'
      + '<flow name="f"><eqn>1</eqn></flow></variables></model>'
      + "<sim_specs><start>0</start><stop>10</stop><dt>1</dt></sim_specs></xmile>";
    const r = runWith(xml, "import", "-");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^stock S = 1/m); // the model still comes out on stdout
    expect(r.err).toMatch(/Euler/);
  });

  it("import refuses a file that is not XMILE", () => {
    const r = runWith("<html><body>nope</body></html>", "import", "-");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is this an XMILE/);
  });
});

describe("flowloom CLI — machine-readable output", () => {
  it("check --json is JSON with or without --numerics", () => {
    const plain = run("check", "examples/sir-epidemic.flow", "--json");
    expect(plain.code).toBe(0);
    const d = JSON.parse(plain.out) as { ok: boolean; stocks: number; numerics?: unknown };
    expect(d.ok).toBe(true);
    expect(d.stocks).toBe(3);
    expect(d.numerics).toBeUndefined();

    const checked = JSON.parse(run("check", "examples/sir-epidemic.flow", "--numerics", "--json").out) as { numerics: { converged: boolean } };
    expect(checked.numerics.converged).toBe(true);
  });

  it("run --json emits parseable series", () => {
    const r = run("run", "examples/logistic-growth.flow", "--json");
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { t: number[]; series: Record<string, number[]> };
    expect(data.t.length).toBeGreaterThan(1);
    expect(data.series.Population!.length).toBe(data.t.length);
  });

  it("--set rewrites a param before the run", () => {
    const base = JSON.parse(run("run", "examples/logistic-growth.flow", "--json").out) as { series: Record<string, number[]> };
    const set = JSON.parse(run("run", "examples/logistic-growth.flow", "--set", "carrying=500", "--json").out) as { series: Record<string, number[]> };
    expect(set.series.Population!.at(-1)!).toBeLessThan(base.series.Population!.at(-1)!);
  });
});
