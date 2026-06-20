// ── Tutorial content ────────────────────────────────────────────────────────
// Data for the three learning modes built on the tour engine. Validators read
// the same live `store.run` the e2e tests assert against, so a lesson advances
// only when the model genuinely reaches the right shape.

import type { Tour, Step } from "./tour.js";
import { EXAMPLES } from "../examples/index.js";

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

export const LESSONS: { name: string; tour: Tour }[] = [
  { name: "Build limits-to-growth", tour: LIMITS_TO_GROWTH },
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
