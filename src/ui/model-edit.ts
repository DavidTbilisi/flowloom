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

/** Rebind a `param`/`const` (or `stock` init) to a numeric value, preserving the
 *  keyword, name, and any [unit] annotation. Used to write calibrated values back
 *  into the canonical text. Leaves the source unchanged if the name isn't found. */
export function setParamValue(source: string, name: string, value: number): string {
  const lines = source.split(/\r?\n/);
  // `param NAME [unit]? = …` / `const …` / `stock NAME [unit]? = …`
  const re = new RegExp(`^(\\s*(?:param|const|stock)\\s+${name}\\s*(?:\\[[^\\]]*\\]\\s*)?=\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(re);
    if (m) {
      // keep any trailing `# doc` comment on the line
      const comment = m[2]!.match(/\s+#.*$/)?.[0] ?? "";
      lines[i] = `${m[1]}${round(value)}${comment}`;
      break;
    }
  }
  return lines.join("\n");
}

/** Compact a fitted number for text: trim to ~6 significant digits, no exponent noise. */
function round(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}
