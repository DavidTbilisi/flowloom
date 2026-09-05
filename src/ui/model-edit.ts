// Small, surgical edits to model *text* so toolbar controls keep the source as
// the single source of truth (an AI editing the same text sees the same change).

/** Set one `sim` setting (dt/to/start/method), updating or inserting the sim line. */
export function setSimSetting(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*sim\b/.test(l));
  if (i === -1) {
    // append a sim line at the end
    const trimmed = source.replace(/\s*$/, "");
    return `${trimmed}\nsim ${key}=${value}`;
  }
  const line = lines[i]!;
  const re = new RegExp(`\\b${key}=\\S+`);
  lines[i] = re.test(line) ? line.replace(re, `${key}=${value}`) : `${line} ${key}=${value}`;
  return lines.join("\n");
}

/** Rebind a `param`/`const`/`switch` (or `stock` init) to a numeric value,
 *  preserving the keyword, name, and any [unit] annotation. Used to write
 *  calibrated values and slider moves back into the canonical text. A `switch`
 *  is written as on/off. Leaves the source unchanged if the name isn't found. */
export function setParamValue(source: string, name: string, value: number): string {
  const lines = source.split(/\r?\n/);
  // `param NAME [unit]? = …` / `const …` / `switch NAME = …` / `stock NAME [unit]? = …`
  // `(?:>=\s*0\s*)?` keeps a `stock X >= 0 = …` floor on the left of the split,
  // so a slider or a calibration write-back preserves the declared floor.
  const re = new RegExp(`^(\\s*(param|const|switch|stock)\\s+${name}\\s*(?:\\[[^\\]]*\\]\\s*)?(?:>=\\s*0\\s*)?=\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(re);
    if (m) {
      // Everything after the value has to survive being rewritten: the trailing
      // `# doc` comment, and a declared range (`± 0.01`, `in 800..1400`). The
      // range is what Monte Carlo, global sensitivity and calibrate all read —
      // and calibrate writes through here, so erasing it would mean the one
      // analysis that honours the bounds is also the one that deletes them.
      const tail = m[3]!.match(/(\s*(?:±|\+\/-)\s*\S+|\s+in\s+\S+\s*\.\.\s*\S+)?(\s+#.*)?$/);
      const suffix = `${tail?.[1] ?? ""}${tail?.[2] ?? ""}`;
      const text = m[2] === "switch" ? (value ? "on" : "off") : round(value);
      lines[i] = `${m[1]}${text}${suffix}`;
      break;
    }
  }
  return lines.join("\n");
}

/** Set one `key=value` binding on a `scenario NAME …` line (replacing it if the
 *  key is already bound, appending it otherwise), keeping any trailing comment.
 *  `value` is written verbatim — pass "on"/"off" for a switch. Leaves the source
 *  unchanged if no such scenario line exists. */
export function setScenarioValue(source: string, scenario: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  const head = new RegExp(`^\\s*scenario\\s+${scenario}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!head.test(line)) continue;
    const hash = line.search(/\s*#/);
    const body = hash >= 0 ? line.slice(0, hash) : line;
    const comment = hash >= 0 ? line.slice(hash) : "";
    const re = new RegExp(`(\\s)${key}=\\S+`);
    lines[i] = (re.test(body) ? body.replace(re, `$1${key}=${value}`) : `${body.replace(/\s*$/, "")} ${key}=${value}`) + comment;
    break;
  }
  return lines.join("\n");
}

/** Compact a fitted number for text: trim to ~6 significant digits, no exponent noise. */
function round(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}
