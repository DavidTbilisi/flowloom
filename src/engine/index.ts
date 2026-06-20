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
export {
  parseUnit,
  inferDim,
  checkUnits,
  buildUnitEnv,
  fmtDim,
  eqDim,
  mulDim,
  divDim,
  powDim,
  isDimensionless,
  UNKNOWN,
  UnitParseError,
  type Dim,
  type DimResult,
  type UnitEnv,
} from "./units.js";
export { solveParam, type SolveResult, type SolveOptions } from "./solve.js";
export { monteCarlo, type EnsembleResult, type Bands, type MonteCarloOptions } from "./ensemble.js";
export { u01, n01, runif, rnorm, RANDOM_FNS } from "./rng.js";
export { parseDataset, type Dataset, type ParseDatasetOptions } from "./dataset.js";
export { interpAt, rmse, nrmse } from "./fit.js";
export { calibrate, type CalibrateOptions, type CalibrateResult } from "./calibrate.js";
export { applyOverride } from "./overrides.js";
