export { simulate, simulateAsync, runPlan, worthWasm, type SimResult } from "./simulator.js";
export {
  buildPlan,
  tsBackend,
  initStateInto,
  runIntegration,
  compileWith,
  makeSlotMap,
  type SimPlan,
  type DerivBackend,
} from "./codegen.js";
export { compile, type Compiled, type StateVar, type CompiledVar } from "./compile.js";
export { analyzeLoops, influenceGraph, findLoops, type Loop, type LoopReport, type Edge, type InfluenceGraph } from "./loops.js";
export { evalExpr, EvalError, type EvalCtx } from "./eval.js";
export { BUILTINS, ARITY, STATEFUL, lookupTable } from "./builtins.js";
export { REFERENCE, REFERENCE_BY_NAME, CALLABLE_NAMES, type RefEntry, type RefKind } from "./reference.js";
export { describeModel, explainModel, type ModelDescription } from "./introspect.js";
export { summarizeRun, resolveMetric, type RunSummary, type SeriesSummary, type Behavior } from "./summarize.js";
export {
  sweepParam,
  sensitivity,
  type SweepResult,
  type SweepPoint,
  type SensitivityResult,
  type SensitivityRow,
} from "./sweep.js";
export { lintModel } from "./lint.js";
export { solveParam, type SolveResult, type SolveOptions } from "./solve.js";
export { applyOverride } from "./overrides.js";
