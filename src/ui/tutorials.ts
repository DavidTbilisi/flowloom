// ── Tutorial content ────────────────────────────────────────────────────────
// Data for the three learning modes built on the tour engine. Validators read
// the same live `store.run` the e2e tests assert against, so a lesson advances
// only when the model genuinely reaches the right shape.

import type { Tour, Step } from "./tour.js";
import { EXAMPLES } from "../examples/index.js";
import { lintModel } from "../engine/index.js";

// ── 1. UI tour (first-run orientation) ───────────────────────────────────────
export const UI_TOUR: Tour = [
  {
    title: "Welcome to flowloom",
    body: "A systems-thinking studio where the model is plain text. In two minutes you'll know your way around. Use Next / Back, or ✕ to leave.",
  },
  {
    title: "The model is text",
    body: "Everything starts here. Stocks, flows, and feedback loops are written as lines — the diagram and plots are derived from them, so an AI can read and edit your model directly.",
    target: "#src",
  },
  {
    title: "Run it",
    body: "Edits re-run automatically; this button (or ⌘/Ctrl + Enter) runs immediately.",
    target: "#run",
  },
  {
    title: "Five views",
    body: "Plot, Diagram, Loops, Table, and the Format reference. They all share one playback clock.",
    target: ".tabs",
  },
  {
    title: "The causal diagram",
    body: "Boxes are stocks filling to their level; pills are flows. Green links push the same way, red the opposite. Press play to animate.",
    target: "#diagram",
    before: (c) => c.gotoTab("diagram"),
  },
  {
    title: "Feedback loops, found for you",
    body: "Every loop is detected and labelled R (reinforcing) or B (balancing). Hover a chip to trace it on the diagram.",
    target: "#loopChips",
    before: (c) => c.gotoTab("diagram"),
  },
  {
    title: "Play and scrub",
    body: "Play, pause, or drag through time. The plot cursor, diagram, and table all follow.",
    target: "#transport-diagram",
    before: (c) => c.gotoTab("diagram"),
  },
  {
    title: "This help bar",
    body: "Hover anything — a keyword, a node, a control — and its explanation appears here.",
    target: "#statusbar",
  },
  {
    title: "Keep learning",
    body: "The Learn button has interactive lessons and guided walkthroughs of every example. Have fun!",
    target: "#learn",
  },
];

// ── 2. Interactive lessons (you type; it validates) ──────────────────────────
const LIMITS_TO_GROWTH: Tour = [
  {
    title: "Build limits-to-growth",
    body: "We'll build the classic S-curve together. Starting point: a population that can grow, but can't yet. Press Next.",
    before: (c) =>
      c.setEditor(
        `# Lesson: limits to growth\nstock Population = 5\n\nparam birthRate = 0.7\nparam carrying  = 1000\n\nsim dt=0.1 to=25 method=rk4\nplot Population\n`,
      ),
  },
  {
    title: "Add the growth flow",
    body: "On a new line add:  flow growth = birthRate * Population * (1 - Population / carrying)  — it grows fast when small, and tails off near the carrying capacity.",
    gate: "valid",
    validate: (c) => !!c.store.run.model?.varIndex.has("growth"),
  },
  {
    title: "Drive the stock with it",
    body: "Now connect the flow to the stock — add:  change(Population) = growth",
    gate: "valid",
    validate: (c) => !!c.store.run.model?.rates.has("Population"),
  },
  {
    title: "See the loop",
    body: "Open Diagram or Loops — flowloom found exactly one reinforcing (R) loop: Population feeds its own growth. The balancing brake lives inside that same flow, near the ceiling.",
    before: (c) => c.gotoTab("loops"),
    gate: "valid",
    validate: (c) => c.store.run.ok && c.store.run.loops?.counts.R === 1,
  },
  {
    title: "You built it 🎉",
    body: "That's a complete model: one stock, one flow, one loop — the limits-to-growth archetype. Try changing carrying or birthRate and watch the curve respond.",
  },
];

// A balancing loop: a stock that homes in on a target (Newton's cooling).
const GOAL_SEEKING: Tour = [
  {
    title: "Build a balancing loop",
    body: "The opposite of runaway growth: a stock that closes a gap. We'll cool a hot drink toward room temperature. Press Next.",
    before: (c) =>
      c.setEditor(
        `# Lesson: goal-seeking (cooling)\nstock Temp = 90\n\nparam ambient = 20\nparam rate    = 0.3\n\nsim dt=0.1 to=20 method=rk4\nplot Temp\n`,
      ),
  },
  {
    title: "Close the gap",
    body: "Add a rate proportional to how far Temp is from ambient:  change(Temp) = -rate * (Temp - ambient)  — the further from room temperature, the faster it cools.",
    gate: "valid",
    validate: (c) => !!c.store.run.model?.rates.has("Temp"),
  },
  {
    title: "One balancing loop",
    body: "Open Loops: flowloom found a single B (balancing) loop — Temp counteracts its own gap. The curve is an exponential approach that flattens at ambient.",
    before: (c) => c.gotoTab("loops"),
    gate: "valid",
    validate: (c) => c.store.run.ok && (c.store.run.loops?.counts.B ?? 0) === 1,
  },
  {
    title: "Goal-seeking, built 🎉",
    body: "Reinforcing (R) loops compound; balancing (B) loops stabilise. Most interesting models are a tug-of-war between the two. Try raising `rate` to cool faster.",
  },
];

// Stochastic input: showcase seeded randomness from Phase 2.
const ADD_RANDOMNESS: Tour = [
  {
    title: "Add randomness",
    body: "Real systems are noisy. We'll turn a steady drift into a random walk. Press Next for a starting point.",
    before: (c) =>
      c.setEditor(
        `# Lesson: a random walk\nstock Walk = 0\n\nparam vol = 1\n\nsim dt=0.5 to=50 method=rk4 seed=1\nplot Walk\n`,
      ),
  },
  {
    title: "A noisy flow",
    body: "Add a flow drawing Gaussian noise:  flow shock = random_normal(0, vol)  — a fresh sample each step, but seeded, so the run is reproducible.",
    gate: "valid",
    validate: (c) => !!c.store.run.model?.varIndex.has("shock"),
  },
  {
    title: "Drive the walk",
    body: "Connect it:  change(Walk) = shock  — now Walk wanders. Run it and watch the jagged path.",
    gate: "valid",
    validate: (c) => !!c.store.run.model?.rates.has("Walk"),
  },
  {
    title: "Seeded and reproducible 🎉",
    body: "Change `seed=1` to `seed=2` for a different but repeatable path. The CLI `montecarlo` runs many seeds at once and draws percentile bands. Default seed is 0, so models stay reproducible.",
  },
];

// Units: showcase the Phase 1 dimensional check.
const CHECK_UNITS: Tour = [
  {
    title: "Catch a unit mistake",
    body: "Annotate quantities with [unit] and flowloom checks the dimensions. This model has a deliberate bug. Press Next.",
    before: (c) =>
      c.setEditor(
        `# Lesson: units checking\nstock Tank [liters] = 0\n\nparam inflow  [liters/min] = 10\nparam leak    [liters] = 1\n\nchange(Tank) = inflow - leak\n\nsim dt=0.1 to=20 timeunit=min\nplot Tank\n`,
      ),
  },
  {
    title: "Spot the warning",
    body: "Open Loops/Table or hover the editor — lint flags it: you can't subtract `liters` from `liters/min`. `leak` is a *rate*, so it should be liters/min too. Fix its unit annotation.",
    gate: "valid",
    validate: (c) => {
      const m = c.store.run.model;
      return !!m && !lintModel(m).some((d) => /unit mismatch/.test(d.message));
    },
  },
  {
    title: "Dimensionally sound 🎉",
    body: "With both as liters/min the mismatch is gone, and change(Tank) correctly resolves to liters per minute. Un-annotated names are left unchecked, so units are opt-in — annotate only what you want verified.",
  },
];

export const LESSONS: { name: string; tour: Tour }[] = [
  { name: "Build limits-to-growth", tour: LIMITS_TO_GROWTH },
  { name: "Build a balancing loop", tour: GOAL_SEEKING },
  { name: "Add randomness", tour: ADD_RANDOMNESS },
  { name: "Catch a unit mistake", tour: CHECK_UNITS },
];

// ── 3. Example walkthroughs (annotated tours of the built-ins) ───────────────
function walkthrough(name: string, blurb: string): Tour {
  return [
    {
      title: name,
      body: `${blurb}  Read the model on the left — every line is one stock, flow, parameter, or setting.`,
      target: "#src",
      before: (c) => c.loadExample(name),
    },
    {
      title: "Watch it run",
      body: "Here's the behaviour over time. Press play, or scrub the slider, to see how the stocks evolve.",
      target: "#view-plot",
      before: (c) => {
        c.gotoTab("plot");
        c.setFrame(c.store.frameCount - 1);
      },
    },
    {
      title: "…and why",
      body: "The structure that produces that behaviour: the causal diagram and its feedback loops, labelled R or B.",
      target: "#loopChips",
      before: (c) => c.gotoTab("diagram"),
    },
  ];
}

export const WALKTHROUGHS: { name: string; tour: Tour }[] = EXAMPLES.map((e) => ({
  name: e.name,
  tour: walkthrough(e.name, e.blurb),
}));

// re-export Step for convenience
export type { Step };
