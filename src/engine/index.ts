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
