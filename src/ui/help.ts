// In-app language reference (the Format tab). Mirrors docs/language.md so the
// quick reference is always one click away.

export function renderHelp(): string {
  return `
  <p class="hint">A model is plain text — the canonical form an AI can read and write. Every line is one of these. Comments start with <code>#</code>.</p>
  <table class="grammar">
    <tr><td>stock NAME [unit] = EXPR</td><td>an accumulator (an integral). EXPR is its initial value.</td></tr>
    <tr><td>d(NAME) = EXPR</td><td>the net rate of change of a stock — <i>literally</i> dNAME/dt. This is the engine.</td></tr>
    <tr><td>flow NAME [unit] = EXPR</td><td>a named rate; same as aux but drawn as a flow on the diagram.</td></tr>
    <tr><td>aux NAME [unit] = EXPR</td><td>an instantaneous computed value (a converter/variable).</td></tr>
    <tr><td>param NAME [unit] = EXPR</td><td>a constant knob (<code>const</code> is an alias).</td></tr>
    <tr><td>table NAME = (x,y) (x,y) …</td><td>a graphical lookup function; call it as <code>NAME(x)</code> (piecewise-linear).</td></tr>
    <tr><td>sim dt=.1 to=50 start=0 method=rk4</td><td>simulation settings (the toolbar edits this line).</td></tr>
    <tr><td>plot A B C</td><td>which series start visible.</td></tr>
  </table>

  <details open><summary>Expressions</summary><div class="body">
    Standard math: <code>+ - * / % ^</code> (<code>**</code> also means power; <code>^</code> is right-associative).
    Variable <code>t</code> (or <code>time</code>) is the current time. Functions:
    <code>min max abs exp ln log10 sqrt pow sin cos tan floor ceil round sign</code>,
    plus <code>if(cond, a, b)</code> and <code>clamp(x, lo, hi)</code>; constants <code>PI E</code>.
  </div></details>

  <details><summary>Test inputs (drive a model over time)</summary><div class="body">
    <code>step(height, t0)</code> — 0 then <code>height</code> after <code>t0</code>.<br/>
    <code>pulse(t0, width)</code> — 1 during <code>[t0, t0+width)</code>.<br/>
    <code>ramp(slope, t0, t1)</code> — a linear ramp between two times.
  </div></details>

  <details><summary>Delays &amp; smoothing (carry state over time)</summary><div class="body">
    <code>smooth(input, τ)</code> / <code>smoothi(input, τ, init)</code> — first-order exponential smoothing.<br/>
    <code>smooth3(input, τ)</code> — third-order smoothing.<br/>
    <code>delay1(input, τ)</code> / <code>delay3(input, τ)</code> — first/third-order material delays.
    These expand into internal stocks, so they integrate correctly under RK4 and participate in feedback loops.
  </div></details>

  <details><summary>The one idea</summary><div class="body">
    A stock is the running integral of its net flow: <code>stock(t+dt) = stock(t) + dt · d(stock)</code>.
    You write the derivative; flowloom integrates it. Reinforcing (R) loops compound; balancing (B) loops seek a goal.
    Limits-to-growth = an R loop meeting a B brake near a ceiling — see the <i>Logistic growth</i> example.
  </div></details>`;
}
