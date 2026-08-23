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
    <tr><td>param NAME [unit] = EXPR</td><td>a constant knob — sliders, sensitivity and calibration vary it.</td></tr>
    <tr><td>const NAME [unit] = EXPR</td><td>a structural constant (a calendar length, a conversion) — same maths, but no slider and skipped by sensitivity.</td></tr>
    <tr><td>switch NAME = on|off</td><td>a two-state policy toggle; use it as <code>if(NAME, a, b)</code>. Sensitivity tests it off→on; Tune shows a toggle.</td></tr>
    <tr><td>table NAME = (x,y) (x,y) …</td><td>a graphical lookup function; call it as <code>NAME(x)</code> (piecewise-linear).</td></tr>
    <tr><td>scenario NAME key=value …</td><td>a named set of overrides kept in the text (params, switches, stock inits, dt/to). Pick it in the plot controls; base stays dashed.</td></tr>
    <tr><td>sim dt=.1 to=50 start=0 method=rk4</td><td>simulation settings (the toolbar edits this line). Add <code>timeunit=month</code> for units checking.</td></tr>
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

  <details><summary>The leverage ladder (<code># @rung N</code>)</summary><div class="body">
    Tag a <code>param</code>, <code>switch</code> or <code>scenario</code> with its Meadows leverage-point rung in the doc comment —
    <code>param wants = 1805  # @rung 12 the cafe line</code> (12 = constants … 1 = transcending paradigms).
    Tune groups tagged knobs under their rung; <code>flowloom leverage --metric …</code> measures every lever on the ladder.
  </div></details>

  <details><summary>Discrete periods (months, years)</summary><div class="body">
    A budget or a census is a map on a grid, not an ODE: write <code>sim method=euler dt=1</code> so
    <code>stock(t+1) = stock(t) + change(t)</code> exactly, and test the clock with <code>t % 12 == 0</code>.<br/>
    <code>previous(X, init?)</code> — X one step ago.<br/>
    <code>delay_fixed(X, n, init?)</code> — X exactly <code>n</code> time units ago (a pipeline; <code>delay1</code>/<code>delay3</code> are exponential lags).
    Both sample on the grid and hold across RK4 sub-steps; before enough history exists they return <code>init</code> (default: X's initial value).
    They break instantaneous dependencies, so <code>a = previous(b) + 1</code>, <code>b = a * 2</code> is legal.
  </div></details>

  <details><summary>The one idea</summary><div class="body">
    A stock is the running integral of its net flow: <code>stock(t+dt) = stock(t) + dt · d(stock)</code>.
    You write the derivative; flowloom integrates it. Reinforcing (R) loops compound; balancing (B) loops seek a goal.
    Limits-to-growth = an R loop meeting a B brake near a ceiling — see the <i>Logistic growth</i> example.
  </div></details>`;
}
