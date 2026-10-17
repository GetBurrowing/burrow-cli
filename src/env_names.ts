/**
 * The ONE place a `BURROW_*` / `SUITE_*` environment variable is read.
 *
 * The CLI is being renamed from Suite to Burrow. Every variable it reads keeps
 * its suffix and swaps its prefix: `SUITE_X` becomes `BURROW_X`. During the
 * transition both are honoured, with one precedence rule, stated once:
 *
 *   1. `BURROW_X` when it is set AND non-empty;
 *   2. otherwise `SUITE_X` (whatever it holds, including empty);
 *   3. when both are set, `BURROW_X` wins and nothing is printed.
 *
 * When the value came from `SUITE_X` alone, ONE line goes to stderr per
 * suffix per process — `burrow: SUITE_X is deprecated, set BURROW_X` — so an
 * operator learns about the rename without a wall of repeats.
 *
 * WHY ONE RESOLVER. A per-call-site `env.BURROW_X ?? env.SUITE_X` drifts: one
 * site gets `??`, another `||`, a third forgets the fallback, and the variable
 * means different things in different commands. A test asserts that no other
 * file under `src/` reads a `SUITE_*` name from an environment (env_names.test.ts).
 *
 * WRITES ARE NOT THIS MODULE'S JOB, beyond {@link bothNames}. Names consumed by
 * pinned channel plugins keep being written as `SUITE_*`; whether a write also
 * carries the `BURROW_*` name is decided at the write site.
 */

type Env = Record<string, string | undefined>;

export const BURROW_PREFIX = "BURROW_";
export const SUITE_PREFIX = "SUITE_";

/**
 * Every suffix this CLI (and its launcher and installer) reads under both
 * prefixes. A RAW hand-written list, deliberately not derived from the code:
 * the test compares it to a literal array, so adding or dropping a name is a
 * reviewed change in two places, never a silent one.
 */
export const FALLBACK_SUFFIXES = [
  "GITHUB_OWNER",
  "CLI_REF",
  "CLI_TARBALL_URL",
  "LIB_DIR",
  "VERSION",
  "MCP_URL",
  "WS_URL",
  "RUNTIME_ID",
  "RUNTIME_TOKEN",
  "TOKEN",
  "URL",
  "TELEMETRY_AUTH",
  "WATCH_SUPERVISED",
  "CODEX_BRIDGE_SOCKET",
  "ALLOW_PERMISSION_RELAY",
  "CLI_ALLOW_NO_TMUX",
  "CLI_ALLOW_NO_CODEX",
] as const;

export type FallbackSuffix = (typeof FALLBACK_SUFFIXES)[number];

/** `BURROW_<suffix>`. */
export const burrowName = (suffix: FallbackSuffix): string => `${BURROW_PREFIX}${suffix}`;

/** `SUITE_<suffix>`, the legacy name. */
export const suiteName = (suffix: FallbackSuffix): string => `${SUITE_PREFIX}${suffix}`;

/** Where a resolved value came from, so an error can name the variable the operator actually set. */
export interface EnvSource {
  name: string;
  value: string;
}

/* Deprecation notices ------------------------------------------------------ */

let warned = new Set<FallbackSuffix>();
let sink: (line: string) => void = (line) => void process.stderr.write(`${line}\n`);

/** The exact deprecation line for `suffix`. */
export const deprecationLine = (suffix: FallbackSuffix): string =>
  `burrow: ${suiteName(suffix)} is deprecated, set ${burrowName(suffix)}`;

/**
 * Test hook: route deprecation lines to `next` and forget which suffixes have
 * already warned. Returns the previous sink so a test can restore it.
 */
export function setDeprecationSink(next: (line: string) => void): (line: string) => void {
  const prev = sink;
  sink = next;
  warned = new Set();
  return prev;
}

function noteLegacy(suffix: FallbackSuffix): void {
  if (warned.has(suffix)) return;
  warned.add(suffix);
  sink(deprecationLine(suffix));
}

/* Reads -------------------------------------------------------------------- */

/**
 * The variable that supplies `suffix`, by the precedence rule above, or null
 * when neither name is set. Emits the deprecation line when the legacy name
 * supplied a non-empty value.
 */
export function envSource(env: Env, suffix: FallbackSuffix): EnvSource | null {
  const burrow = env[burrowName(suffix)];
  if (burrow !== undefined && burrow !== "") return { name: burrowName(suffix), value: burrow };
  const legacy = env[suiteName(suffix)];
  if (legacy === undefined) return null;
  if (legacy !== "") noteLegacy(suffix);
  return { name: suiteName(suffix), value: legacy };
}

/** The value for `suffix`: `BURROW_<suffix>` when non-empty, else `SUITE_<suffix>`. */
export function envValue(env: Env, suffix: FallbackSuffix): string | undefined {
  return envSource(env, suffix)?.value;
}

/** `{BURROW_<suffix>: value, SUITE_<suffix>: value}`, for a write both generations must read. */
export function bothNames(suffix: FallbackSuffix, value: string): Record<string, string> {
  return { [burrowName(suffix)]: value, [suiteName(suffix)]: value };
}

/* Reads of a WRITTEN entry's env ------------------------------------------- */

/**
 * The value an MCP entry's `env` map (or a `.mcp.json`) carries for `suffix`,
 * by the same precedence rule as {@link envValue}: `BURROW_<suffix>` when it is
 * a non-empty string, else `SUITE_<suffix>` when that is one, else undefined.
 *
 * NOT the process environment, so no deprecation line: an entry written by
 * 0.7.3 carries only `SUITE_*`, and that is a fact about the file, not about
 * anything the operator set. Values are trimmed; a non-string is absent.
 */
export function entryValue(env: Record<string, unknown> | undefined | null, suffix: FallbackSuffix): string | undefined {
  if (env === undefined || env === null) return undefined;
  for (const name of [burrowName(suffix), suiteName(suffix)]) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * Does every name an entry carries for `suffix` equal `want`, with at least one
 * present? A `SUITE_*`-only entry (0.7.3) with the wanted value AGREES.
 *
 * STRICTER THAN {@link entryValue} ON PURPOSE. The pinned channel plugin reads
 * only `SUITE_*`, so an entry whose `BURROW_X` is right and whose `SUITE_X` is
 * wrong runs on the WRONG value today. Reading it BURROW-first would call that
 * entry current and never rewrite it; this calls it stale. Compared untrimmed:
 * it answers "is the file exactly what we would write".
 */
export function entryAgrees(env: Record<string, unknown> | undefined | null, suffix: FallbackSuffix, want: string): boolean {
  if (env === undefined || env === null) return false;
  let seen = 0;
  for (const name of [burrowName(suffix), suiteName(suffix)]) {
    const v = env[name];
    if (v === undefined) continue;
    seen++;
    if (v !== want) return false;
  }
  return seen > 0;
}
