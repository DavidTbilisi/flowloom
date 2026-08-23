// ── Reference datasets ───────────────────────────────────────────────────────
// Parse an observed time series (CSV/TSV) into columns the calibrator can fit a
// model against. Engine code stays I/O-free: the CLI/UI read the file and hand
// the text here, mirroring how model .flow text is read. One column is time; the
// rest are named series. Rows are sorted by time so interpolation is well-defined.

import { lookupTable } from "./builtins.js";

export interface Dataset {
  /** Observation times, ascending. */
  t: number[];
  /** Series name → values, aligned index-for-index with `t`. */
  columns: Map<string, number[]>;
}

export interface ParseDatasetOptions {
  /** Field delimiter; auto-detected (tab if any tabs present, else comma) when omitted. */
  delimiter?: string;
  /** Header name of the time column; defaults to a "t"/"time" column, else the first. */
  timeColumn?: string;
}

/** Parse CSV/TSV text with a header row into a {@link Dataset}. */
export function parseDataset(text: string, opts: ParseDatasetOptions = {}): Dataset {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("dataset needs a header row and at least one data row");

  const delim = opts.delimiter ?? (lines[0]!.includes("\t") ? "\t" : ",");
  const header = lines[0]!.split(delim).map((h) => h.trim());

  // Choose the time column: explicit name, else a t/time header, else column 0.
  let tIdx = 0;
  if (opts.timeColumn) {
    tIdx = header.findIndex((h) => h === opts.timeColumn);
    if (tIdx < 0) throw new Error(`time column "${opts.timeColumn}" not found in header`);
  } else {
    const named = header.findIndex((h) => /^(t|time)$/i.test(h));
    if (named >= 0) tIdx = named;
  }

  const seriesCols = header.map((name, i) => ({ name, i })).filter(({ i }) => i !== tIdx);
  const rows: Array<{ t: number; vals: number[] }> = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split(delim);
    const tv = Number(cells[tIdx]);
    if (!Number.isFinite(tv)) continue; // skip rows with no usable time
    rows.push({ t: tv, vals: seriesCols.map(({ i }) => Number(cells[i])) });
  }
  if (!rows.length) throw new Error("dataset has no numeric data rows");
  rows.sort((a, b) => a.t - b.t);

  const columns = new Map<string, number[]>();
  seriesCols.forEach(({ name }, c) => columns.set(name, rows.map((row) => row.vals[c]!)));
  return { t: rows.map((row) => row.t), columns };
}

// ── Between files and text ───────────────────────────────────────────────────
// A `data` line is the in-text form of a measured series; these two helpers
// are the bridge each way, so the model stays one canonical text while the
// numbers can still come from, and go back to, a CSV.

export interface DataLineOptions {
  /** Columns to emit (default: every series column). */
  columns?: string[];
  /** Unit annotation for each line (`data NAME [unit] = …`). */
  unit?: string;
  /** Emit `linear` (interpolate) instead of the default step-hold. */
  linear?: boolean;
  /** Significant digits per value (default 6). */
  precision?: number;
}

/** Render dataset columns as `data NAME = (t, v) (t, v) …` lines. */
export function dataLines(ds: Dataset, opts: DataLineOptions = {}): string[] {
  const cols = opts.columns?.length ? opts.columns : [...ds.columns.keys()];
  const p = opts.precision ?? 6;
  const num = (v: number) => String(Number(v.toPrecision(p)));
  return cols.map((c) => {
    const vals = ds.columns.get(c);
    if (!vals) throw new Error(`dataset has no column "${c}" (have: ${[...ds.columns.keys()].join(", ")})`);
    const pts: string[] = [];
    for (let i = 0; i < ds.t.length; i++) if (Number.isFinite(vals[i]!)) pts.push(`(${num(ds.t[i]!)}, ${num(vals[i]!)})`);
    if (pts.length < 2) throw new Error(`column "${c}" has fewer than two numeric points`);
    const name = /^[A-Za-z_]\w*$/.test(c) ? c : c.replace(/\W+/g, "_").replace(/^(\d)/, "_$1");
    return `data ${name}${opts.unit ? ` [${opts.unit}]` : ""} = ${pts.join(" ")}${opts.linear ? " linear" : ""}`;
  });
}

/** A dataset assembled from a model's own `data` series: the union of their
 *  sample times, each series read by its own rule (hold or linear) at every
 *  time — so calibrate can fit against in-text data with no file at all. */
export function datasetFromModel(
  model: { vars: Array<{ name: string; data?: true }>; tables: Map<string, { points: Array<[number, number]>; hold?: true }> },
  names?: string[],
): Dataset {
  const decls = model.vars.filter((v) => v.data && (!names?.length || names.includes(v.name)));
  if (names?.length) for (const n of names) if (!decls.some((d) => d.name === n)) throw new Error(`model has no data series "${n}"${model.vars.some((v) => v.name === n) ? " (it is a computed series, not a data line)" : ""}`);
  if (!decls.length) throw new Error("model declares no `data` lines");
  const times = new Set<number>();
  for (const d of decls) for (const [x] of model.tables.get(`${d.name}#data`)!.points) times.add(x);
  const t = [...times].sort((a, b) => a - b);
  const columns = new Map<string, number[]>();
  for (const d of decls) {
    const tb = model.tables.get(`${d.name}#data`)!;
    columns.set(d.name, t.map((x) => lookupTable(tb.points, x, tb.hold === true)));
  }
  return { t, columns };
}
