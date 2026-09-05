// ── Unit vocabulary ─────────────────────────────────────────────────────────
// units.ts is a well-built dimensional-analysis pass over a vocabulary that was
// one line long: trim + lowercase, "no pluralization magic". So `person` and
// `people` were two different dimensions, `km` and `m` were unrelated, and
// hours↔days could not be resolved without a hand-written
// `const hoursPerDay [hour/day] = 24`.
//
// This module is that vocabulary. Three rules govern it:
//
//  1. **Unknown vocabulary keeps working.** `widgets`, `GEL`, `customers`,
//     `apples` are the common case and must stay free-form: an unrecognised
//     token is its own base dimension, exactly as before.
//  2. **Reduction is dimensional, not numeric.** `km` and `m` are both length,
//     `hour` and `day` are both time — so they unify, and a model annotated in
//     mixed units stops producing false mismatches. flowloom never rescales a
//     number for you (the `[unit]` annotation has never changed the arithmetic),
//     so the factor is *reported*, not applied: see `scaleClashes`.
//  3. **Plurals fold model-locally.** A general `-s` rule turns `mass` into
//     `mas` and `bus` into `bu`. Instead, a trailing `s` is dropped only when
//     the singular is *also* used somewhere in the same model — if a model
//     writes both `widget` and `widgets` they are the same thing, and if it only
//     ever writes `mass`, nothing happens. Irregulars (person/people) are a
//     table, because they have to be.

/** SI base dimensions, plus the ones a systems model actually needs. */
export const BASE_UNITS = ["m", "kg", "s", "A", "K", "mol", "cd", "person", "bit"] as const;

/** token → [base dimension exponents, factor relative to the base]. */
interface Resolved { dim: Array<[string, number]>; factor: number }

const U = (dim: Array<[string, number]>, factor = 1): Resolved => ({ dim, factor });

/**
 * The canonical vocabulary. Keys are already lowercase; the value says what the
 * token *is* in base units and how big it is relative to them.
 *
 * Time is the load-bearing family: `sim timeunit=month` and a rate annotated
 * `[widgets/day]` both reduce to seconds, so they check against each other
 * instead of silently passing as two unrelated dimensions.
 */
const VOCAB = new Map<string, Resolved>([
  // ── time ──
  ["s", U([["s", 1]])], ["sec", U([["s", 1]])], ["second", U([["s", 1]])],
  ["min", U([["s", 1]], 60)], ["minute", U([["s", 1]], 60)],
  ["h", U([["s", 1]], 3600)], ["hr", U([["s", 1]], 3600)], ["hour", U([["s", 1]], 3600)],
  ["day", U([["s", 1]], 86_400)], ["d", U([["s", 1]], 86_400)],
  ["week", U([["s", 1]], 604_800)], ["wk", U([["s", 1]], 604_800)],
  ["fortnight", U([["s", 1]], 1_209_600)],
  // Calendar units are the average, which is what a model that mixes them means.
  ["month", U([["s", 1]], 2_629_800)], ["mo", U([["s", 1]], 2_629_800)],
  ["quarter", U([["s", 1]], 7_889_400)],
  ["year", U([["s", 1]], 31_557_600)], ["yr", U([["s", 1]], 31_557_600)],
  ["decade", U([["s", 1]], 315_576_000)], ["century", U([["s", 1]], 3_155_760_000)],

  // ── length ──
  ["m", U([["m", 1]])], ["meter", U([["m", 1]])], ["metre", U([["m", 1]])],
  ["inch", U([["m", 1]], 0.0254)], ["in", U([["m", 1]], 0.0254)],
  ["ft", U([["m", 1]], 0.3048)], ["foot", U([["m", 1]], 0.3048)], ["feet", U([["m", 1]], 0.3048)],
  ["yard", U([["m", 1]], 0.9144)],
  ["mile", U([["m", 1]], 1609.344)], ["mi", U([["m", 1]], 1609.344)],
  ["nauticalmile", U([["m", 1]], 1852)],

  // ── mass ──
  ["g", U([["kg", 1]], 0.001)], ["gram", U([["kg", 1]], 0.001)],
  ["kg", U([["kg", 1]])], ["kilogram", U([["kg", 1]])],
  ["tonne", U([["kg", 1]], 1000)], ["t", U([["kg", 1]], 1000)], ["ton", U([["kg", 1]], 907.18474)],
  ["lb", U([["kg", 1]], 0.45359237)], ["pound", U([["kg", 1]], 0.45359237)],
  ["oz", U([["kg", 1]], 0.028349523125)], ["ounce", U([["kg", 1]], 0.028349523125)],

  // ── other SI base ──
  ["a", U([["A", 1]])], ["ampere", U([["A", 1]])], ["amp", U([["A", 1]])],
  ["k", U([["K", 1]])], ["kelvin", U([["K", 1]])],
  ["mol", U([["mol", 1]])], ["mole", U([["mol", 1]])],
  ["cd", U([["cd", 1]])], ["candela", U([["cd", 1]])],

  // ── counts of things ──
  ["person", U([["person", 1]])], ["people", U([["person", 1]])], ["capita", U([["person", 1]])],
  ["bit", U([["bit", 1]])], ["byte", U([["bit", 1]], 8)],

  // ── derived ──
  ["hz", U([["s", -1]])], ["hertz", U([["s", -1]])],
  ["n", U([["kg", 1], ["m", 1], ["s", -2]])], ["newton", U([["kg", 1], ["m", 1], ["s", -2]])],
  ["j", U([["kg", 1], ["m", 2], ["s", -2]])], ["joule", U([["kg", 1], ["m", 2], ["s", -2]])],
  ["cal", U([["kg", 1], ["m", 2], ["s", -2]], 4.184)], ["calorie", U([["kg", 1], ["m", 2], ["s", -2]], 4.184)],
  ["w", U([["kg", 1], ["m", 2], ["s", -3]])], ["watt", U([["kg", 1], ["m", 2], ["s", -3]])],
  ["wh", U([["kg", 1], ["m", 2], ["s", -2]], 3600)],
  ["pa", U([["kg", 1], ["m", -1], ["s", -2]])], ["pascal", U([["kg", 1], ["m", -1], ["s", -2]])],
  ["c", U([["A", 1], ["s", 1]])], ["coulomb", U([["A", 1], ["s", 1]])],
  ["v", U([["kg", 1], ["m", 2], ["s", -3], ["A", -1]])], ["volt", U([["kg", 1], ["m", 2], ["s", -3], ["A", -1]])],
  ["l", U([["m", 3]], 0.001)], ["liter", U([["m", 3]], 0.001)], ["litre", U([["m", 3]], 0.001)],
  ["gallon", U([["m", 3]], 0.003785411784)],
  ["hectare", U([["m", 2]], 10_000)], ["acre", U([["m", 2]], 4046.8564224)],
]);

/** SI prefixes, by symbol and by name. */
const PREFIXES = new Map<string, number>([
  ["y", 1e-24], ["z", 1e-21], ["a", 1e-18], ["f", 1e-15], ["p", 1e-12], ["n", 1e-9],
  ["u", 1e-6], ["µ", 1e-6], ["m", 1e-3], ["c", 1e-2], ["d", 1e-1],
  ["da", 1e1], ["h", 1e2], ["k", 1e3], ["M", 1e6], ["G", 1e9], ["T", 1e12],
  ["P", 1e15], ["E", 1e18], ["Z", 1e21], ["Y", 1e24],
  ["yocto", 1e-24], ["zepto", 1e-21], ["atto", 1e-18], ["femto", 1e-15], ["pico", 1e-12],
  ["nano", 1e-9], ["micro", 1e-6], ["milli", 1e-3], ["centi", 1e-2], ["deci", 1e-1],
  ["deca", 1e1], ["hecto", 1e2], ["kilo", 1e3], ["mega", 1e6], ["giga", 1e9], ["tera", 1e12],
  ["peta", 1e15], ["exa", 1e18], ["zetta", 1e21], ["yotta", 1e24],
]);

/**
 * Units a prefix may attach to.
 *
 * Deliberately a whitelist. Prefix parsing is ambiguous — `min` is a minute, not
 * a milli-inch; `cal` is a calorie, not a centi-litre; `day` is not a deca-year
 * — and guessing wrong changes a model's dimensions silently. A token in VOCAB
 * always wins over any prefix reading, and only these bases can take one.
 */
const PREFIXABLE = new Set([
  "m", "meter", "metre", "g", "gram", "s", "sec", "second", "l", "liter", "litre",
  "w", "watt", "j", "joule", "wh", "hz", "hertz", "n", "newton", "pa", "pascal",
  "a", "ampere", "amp", "v", "volt", "c", "coulomb", "bit", "byte", "mol", "mole", "k", "kelvin",
]);

/** Case-sensitive prefix symbols: `M` is mega, `m` is milli — the one place in
 *  the unit vocabulary where case carries meaning, so it is checked before the
 *  lowercase fold that everything else goes through. */
const CASED_PREFIX = new Set(["M", "G", "T", "P", "E", "Z", "Y"]);

/**
 * Resolve one unit token to base dimensions and a factor.
 *
 * Returns `undefined` for vocabulary the library does not know, which is not a
 * failure — that token becomes its own base dimension, the way every token did
 * before this module existed.
 */
export function resolveUnit(raw: string): Resolved | undefined {
  const tok = raw.trim();
  if (!tok) return undefined;
  const lower = tok.toLowerCase();

  // A known unit always wins: `min` is a minute before it is a milli-anything.
  const direct = VOCAB.get(lower);
  if (direct) return direct;

  // Longest prefix first, so `da` (deca) is tried before `d` (deci).
  const cased = [...PREFIXES.keys()].filter((p) => CASED_PREFIX.has(p));
  const candidates = [
    ...cased.filter((p) => tok.startsWith(p)).map((p) => [p, tok.slice(p.length)] as const),
    ...[...PREFIXES.keys()].filter((p) => !CASED_PREFIX.has(p) && lower.startsWith(p))
      .map((p) => [p, lower.slice(p.length)] as const),
  ].sort((x, y) => y[0].length - x[0].length);

  for (const [prefix, rest] of candidates) {
    const restLower = rest.toLowerCase();
    if (!PREFIXABLE.has(restLower)) continue;
    const base = VOCAB.get(restLower);
    if (!base) continue;
    return { dim: base.dim, factor: base.factor * PREFIXES.get(prefix)! };
  }
  return undefined;
}

/**
 * Fold plurals within one model's vocabulary.
 *
 * `tokens` is every unit token the model actually writes. A token ending in `s`
 * (or `es`) collapses onto its singular only when that singular is also present
 * — which is precisely the case where the two spellings must mean one thing, and
 * never turns `mass` into `mas`. Irregulars are already handled by VOCAB, since
 * both spellings resolve to the same base.
 */
export function pluralFolding(tokens: Iterable<string>): Map<string, string> {
  const have = new Set([...tokens].map((t) => t.toLowerCase()));
  const fold = new Map<string, string>();
  for (const t of have) {
    if (VOCAB.has(t)) continue; // known vocabulary needs no guessing
    const singular = t.endsWith("es") && have.has(t.slice(0, -2)) ? t.slice(0, -2)
      : t.endsWith("s") && have.has(t.slice(0, -1)) ? t.slice(0, -1)
      : undefined;
    if (singular && !VOCAB.has(singular)) fold.set(t, singular);
  }
  return fold;
}
