/**
 * The one-shot rename of the last `suite` names this CLI wrote (0.11.0).
 *
 *   MCP server ids     suite-channel  -> burrow-channel
 *                      startup-suite  -> burrow
 *   launch flag        server:suite-channel -> server:burrow-channel
 *   config key         suiteUrl -> burrowUrl
 *   pane wrapper $0    suite-claude-continue -> burrow-claude-continue
 *   channel entry env  SUITE_<X> -> BURROW_<X> (the SUITE_* copies are no longer written)
 *
 * From 0.11.0 every writer writes only the new names, and this module is the
 * ONLY place that spells the old ones. It follows the 0.10.2 agent-root rename
 * as 0.10.3 fixed it:
 *
 *  - The rename runs on the path that STARTS an agent, before the agent reads
 *    anything, and never on a path that attaches to a running agent. A running
 *    Claude Code read its MCP servers at startup; changing their ids under it
 *    would leave its config naming servers it does not have, and its own later
 *    writes to ~/.claude.json are not ours to race.
 *  - Before that start, a reader that must see an unmigrated file (an attach,
 *    `burrow status`, a doctor run) goes through the read-only helpers here
 *    ({@link configUrl}, {@link serverEntry}), which take the old name only
 *    when the new one is absent, and never write.
 *  - Anything that holds BOTH the old and the new name is refused, naming the
 *    file and both names, and NOTHING is renamed: every place is checked before
 *    any is changed. Merging two entries would pick one silently, and the one
 *    it dropped may be the only correct statement of who the agent is.
 *
 * WHERE THE SERVER IDS ARE RENAMED, for one agent folder:
 *   - ~/.claude.json `projects[<folder>].mcpServers` (local scope), through
 *     `claude mcp remove` + `claude mcp add-json`, Claude Code's own writer;
 *   - `<folder>/.mcp.json` `mcpServers` (project scope), in place;
 *   - `enabledMcpjsonServers` / `disabledMcpjsonServers` in
 *     `<folder>/.claude/settings.json` and `settings.local.json`, in place.
 * All three in the same start. Renaming the local entries alone would unshadow
 * a `.mcp.json` that still says `suite-channel`, and an agent whose settings
 * enable that name would come up connected TWICE as one runtime, with every
 * tool under two prefixes.
 *
 * User-scope entries (top-level `mcpServers` in ~/.claude.json) are shared by
 * every folder on the machine and are never renamed here; an old-named one is
 * reported by the convergence check (init.ts) instead.
 */
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** `[old, new]` MCP server ids. The new ids are init.ts CHANNEL_SERVER and TOOLS_SERVER (asserted by test). */
export const SERVER_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["suite-channel", "burrow-channel"],
  ["startup-suite", "burrow"],
];

/** The config key that names the Burrow install's URL, and its pre-0.11.0 spelling. */
export const URL_KEY = "burrowUrl";
export const LEGACY_URL_KEY = "suiteUrl";

/** The pre-0.11.0 development-channel flag value, as recorded in a restore roster. */
export const LEGACY_DEV_CHANNEL = "server:suite-channel";

/** The pre-0.11.0 `$0` of the `--continue` fallback shell (claude.ts continueFallbackArgv). */
export const LEGACY_CONTINUE_WRAPPER = "suite-claude-continue";

const LEGACY_ENV_PREFIX = "SUITE_";
const ENV_PREFIX = "BURROW_";

/** The settings keys that list `.mcp.json` server ids. */
export const MCPJSON_LIST_KEYS = ["enabledMcpjsonServers", "disabledMcpjsonServers"] as const;

/** The settings files, relative to the agent folder, whose lists are renamed. */
export const SETTINGS_FILES = [join(".claude", "settings.json"), join(".claude", "settings.local.json")] as const;

export const MCP_JSON_FILE = ".mcp.json";

/** Something holds both an old and a new name. Nothing was renamed. */
export class LegacyNameConflict extends Error {
  constructor(
    readonly where: string,
    readonly oldName: string,
    readonly newName: string,
  ) {
    super(
      `${where} holds both ${oldName} and ${newName}; burrow 0.11.0 reads only ${newName}, ` +
        `so keep one (remove the other) and start the agent again`,
    );
    this.name = "LegacyNameConflict";
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Json, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/* ------------------------------------------------------------------------- */
/* Read-only helpers for a not-yet-renamed folder                             */
/* ------------------------------------------------------------------------- */

/**
 * The URL a raw config object (machine config, agent record, root identity)
 * carries: `burrowUrl`, else — an unmigrated file — `suiteUrl`, else undefined.
 * Throws {@link LegacyNameConflict} when it carries both. Never writes.
 */
export function configUrl(raw: Json, where = "the config"): unknown {
  const fresh = has(raw, URL_KEY);
  const legacy = has(raw, LEGACY_URL_KEY);
  if (fresh && legacy) throw new LegacyNameConflict(where, LEGACY_URL_KEY, URL_KEY);
  return fresh ? raw[URL_KEY] : raw[LEGACY_URL_KEY];
}

/** The old id `newName` replaced, or undefined when it is not one of ours. */
export function legacyServerId(newName: string): string | undefined {
  return SERVER_RENAMES.find(([, n]) => n === newName)?.[0];
}

/**
 * The entry a server map holds for `newName`: under that id, else — a folder
 * the rename has not reached yet — under its old id. Read-only.
 */
export function serverEntry<T>(map: Record<string, T> | null | undefined, newName: string): T | undefined {
  if (map === null || map === undefined) return undefined;
  if (map[newName] !== undefined) return map[newName];
  const old = legacyServerId(newName);
  return old === undefined ? undefined : map[old];
}

/** The id an entry is actually registered under in `map`: `newName`, else its old id when only that exists. */
export function registeredId(map: Record<string, unknown> | null | undefined, newName: string): string {
  if (map === null || map === undefined || map[newName] !== undefined) return newName;
  const old = legacyServerId(newName);
  return old !== undefined && map[old] !== undefined ? old : newName;
}

/* ------------------------------------------------------------------------- */
/* Pure transforms                                                            */
/* ------------------------------------------------------------------------- */

/**
 * A channel entry's env with every `SUITE_<X>` moved to `BURROW_<X>`. Where
 * both are present the BURROW_ one stays and the SUITE_ copy is dropped: the
 * pinned channel plugin reads BURROW_* first (burrow-channel-claude-code
 * src/env.ts), so the SUITE_ copy was already not what it ran on.
 */
export function renamedEnv(env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX)) {
      out[k] = v;
      continue;
    }
    const next = `${ENV_PREFIX}${k.slice(LEGACY_ENV_PREFIX.length)}`;
    if (has(env, next)) continue;
    out[next] = v;
  }
  return out;
}

/** True when an entry's env still carries a `SUITE_*` name. */
export function hasLegacyEnv(entry: unknown): boolean {
  if (!isObject(entry) || !isObject(entry.env)) return false;
  return Object.keys(entry.env).some((k) => k.startsWith(LEGACY_ENV_PREFIX));
}

/** An entry with its env renamed (see {@link renamedEnv}); everything else untouched. */
export function renamedEntry<T>(entry: T): T {
  if (!isObject(entry) || !isObject(entry.env)) return entry;
  return { ...entry, env: renamedEnv(entry.env) } as T;
}

/** The old ids in `map` that have to move. Throws {@link LegacyNameConflict} when an old and its new id are both there. */
export function pendingServerIds(map: Json | null | undefined, where: string): Array<readonly [string, string]> {
  if (!isObject(map)) return [];
  const todo: Array<readonly [string, string]> = [];
  for (const [oldName, newName] of SERVER_RENAMES) {
    if (!has(map, oldName)) continue;
    if (has(map, newName)) throw new LegacyNameConflict(where, oldName, newName);
    todo.push([oldName, newName]);
  }
  return todo;
}

/** `map` with each old id replaced by its new one IN PLACE in the key order, entries' env renamed. */
export function renamedServerMap(map: Json, where: string): Json {
  pendingServerIds(map, where);
  const out: Json = {};
  for (const [k, v] of Object.entries(map)) {
    const pair = SERVER_RENAMES.find(([o]) => o === k);
    out[pair === undefined ? k : pair[1]] = pair === undefined ? v : renamedEntry(v);
  }
  return out;
}

/** A settings list with old ids replaced, or throws when it names an old id and its new one. */
export function renamedIdList(list: unknown[], where: string): unknown[] {
  for (const [oldName, newName] of SERVER_RENAMES) {
    if (list.includes(oldName) && list.includes(newName)) throw new LegacyNameConflict(where, oldName, newName);
  }
  return list.map((v) => SERVER_RENAMES.find(([o]) => o === v)?.[1] ?? v);
}

/** A raw config object with `suiteUrl` renamed in its key position; throws when it holds both. */
export function renamedConfig(raw: Json, where: string): Json {
  configUrl(raw, where);
  const out: Json = {};
  for (const [k, v] of Object.entries(raw)) out[k === LEGACY_URL_KEY ? URL_KEY : k] = v;
  return out;
}

/**
 * A recorded launch argv with the old development-channel value and the old
 * wrapper `$0` replaced. Only whole argv elements are compared, so nothing
 * inside the fallback shell script or a user argument is touched.
 */
export function renamedLaunchArgv(argv: readonly string[], devChannel: string, wrapper: string): string[] {
  return argv.map((a) => (a === LEGACY_DEV_CHANNEL ? devChannel : a === LEGACY_CONTINUE_WRAPPER ? wrapper : a));
}

/** Is this `ps` row the pre-0.11.0 fallback shell? Adoption must skip it like the current one. */
export function isLegacyContinueWrapper(args: string): boolean {
  return args.split(/\s+/).includes(LEGACY_CONTINUE_WRAPPER);
}

/* ------------------------------------------------------------------------- */
/* Files renamed in place                                                     */
/* ------------------------------------------------------------------------- */

/** One rename this module would make, or made. `file` is absolute; `what` names the change. */
export interface NameChange {
  file: string;
  what: string;
}

interface FilePlan {
  file: string;
  next: string;
  changes: string[];
}

function readJson(file: string): Json | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The rewrite a config file (agent record, root identity, machine config) needs, or null. Throws on a conflict. */
function configFilePlan(file: string): FilePlan | null {
  const raw = readJson(file);
  if (raw === null || !has(raw, LEGACY_URL_KEY)) {
    if (raw !== null) configUrl(raw, file);
    return null;
  }
  const next = renamedConfig(raw, file);
  return { file, next: `${JSON.stringify(next, null, 2)}\n`, changes: [`${LEGACY_URL_KEY} -> ${URL_KEY}`] };
}

/** The rewrite `<root>/.mcp.json` needs, or null. Throws on a conflict. */
function mcpJsonPlan(root: string): FilePlan | null {
  const file = join(root, MCP_JSON_FILE);
  const raw = readJson(file);
  if (raw === null || !isObject(raw.mcpServers)) return null;
  const todo = pendingServerIds(raw.mcpServers, file);
  if (todo.length === 0) return null;
  const next = { ...raw, mcpServers: renamedServerMap(raw.mcpServers, file) };
  return { file, next: `${JSON.stringify(next, null, 2)}\n`, changes: todo.map(([o, n]) => `${o} -> ${n}`) };
}

/** The rewrite one settings file's `.mcp.json` lists need, or null. Throws on a conflict. */
function settingsPlan(file: string): FilePlan | null {
  const raw = readJson(file);
  if (raw === null) return null;
  const next: Json = { ...raw };
  const changes: string[] = [];
  for (const key of MCPJSON_LIST_KEYS) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    const renamed = renamedIdList(list, `${file} ${key}`);
    if (JSON.stringify(renamed) === JSON.stringify(list)) continue;
    next[key] = renamed;
    for (const [o, n] of SERVER_RENAMES) if (list.includes(o)) changes.push(`${key}: ${o} -> ${n}`);
  }
  return changes.length === 0 ? null : { file, next: `${JSON.stringify(next, null, 2)}\n`, changes };
}

/** Write via a sibling temp file and a rename, keeping the file's mode. */
function replaceFile(file: string, body: string): void {
  const mode = statSync(file).mode & 0o7777;
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, body, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Plans for each file, all checked before any is written. Throws the first conflict. */
function planFiles(configFiles: readonly string[], claudeRoot: string | null): FilePlan[] {
  const plans: Array<FilePlan | null> = [];
  for (const f of configFiles) plans.push(configFilePlan(f));
  if (claudeRoot !== null) {
    plans.push(mcpJsonPlan(claudeRoot));
    for (const rel of SETTINGS_FILES) plans.push(settingsPlan(join(claudeRoot, rel)));
  }
  // The same file listed twice (a record that IS the machine config, say) is planned once.
  const seen = new Set<string>();
  return plans.filter((p): p is FilePlan => p !== null && !seen.has(p.file) && (seen.add(p.file), true));
}

/**
 * What the in-place renames would change, without changing it. Throws
 * {@link LegacyNameConflict} when any file holds an old and a new name.
 *
 * `configFiles`: config files whose `suiteUrl` key moves (absent ones are
 * skipped). `claudeRoot`: a Claude Code agent folder whose `.mcp.json` and
 * settings lists move, or null for any other harness.
 */
export function pendingFileRenames(configFiles: readonly string[], claudeRoot: string | null): NameChange[] {
  return planFiles(configFiles, claudeRoot).flatMap((p) => p.changes.map((what) => ({ file: p.file, what })));
}

/**
 * Make the in-place renames. Every file is checked first; a conflict throws
 * {@link LegacyNameConflict} having written nothing. Returns what changed.
 */
export function renameFiles(configFiles: readonly string[], claudeRoot: string | null): NameChange[] {
  const plans = planFiles(configFiles, claudeRoot);
  for (const p of plans) replaceFile(p.file, p.next);
  return plans.flatMap((p) => p.changes.map((what) => ({ file: p.file, what })));
}
