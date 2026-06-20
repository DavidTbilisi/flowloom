// ── Reference datasets ───────────────────────────────────────────────────────
// Parse an observed time series (CSV/TSV) into columns the calibrator can fit a
// model against. Engine code stays I/O-free: the CLI/UI read the file and hand
// the text here, mirroring how model .flow text is read. One column is time; the
// rest are named series. Rows are sorted by time so interpolation is well-defined.

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
