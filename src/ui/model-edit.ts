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
