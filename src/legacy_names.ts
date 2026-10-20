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
 * 0.12.0 adds the names a Hermes home holds (MCP id, platform plugin, token
 * file; the "Hermes" section below), moved on the hermes start path, and the
 * OpenClaw plugin and channel ids (the "OpenClaw" section), which a start
 * refuses rather than moves.
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
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    /** The release that reads only the new name. */
    readonly since = "0.11.0",
  ) {
    super(
      `${where} holds both ${oldName} and ${newName}; burrow ${since} reads only ${newName}, ` +
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

/* ------------------------------------------------------------------------- */
/* Hermes (0.12.0)                                                           */
/* ------------------------------------------------------------------------- */

/*
 * A Hermes home (`HERMES_HOME`, `<root>/.hermes`) holds three names that
 * burrow-channel-hermes before v0.4.0 wrote, and that PERSIST across starts:
 *
 *   config.yaml `mcp_servers.<id>`            startup-suite          -> burrow
 *   the platform plugin (plugins/<name>/,     startup-suite-platform -> burrow-platform
 *     plugins.enabled / plugins.disabled)
 *   the runtime token file                    mcp-tokens/startup-suite-platform.runtime-token
 *                                             -> mcp-tokens/burrow-platform.runtime-token
 *
 * The v0.4.0 installer writes only the new names. Run over an old home it
 * installs a second generation beside the first (two MCP servers, two
 * enabled platform plugins on one runtime), so the old one is moved HERE, on
 * the start path (`burrow hermes`, `--no-session`, `--stamp-only`: every path
 * that stamps), before the installer runs. Never on an attach: the running
 * gateway read these at its start. Never on `--gateway-only` either: that
 * path runs no installer, and an old plugin left installed reads the old
 * token path, so moving the names without the installer that follows would
 * leave the gateway unable to connect.
 *
 * HOW each moves (hermes.ts rule 3: config.yaml is written only by Hermes):
 *   - the MCP entry: `hermes config set mcp_servers.<new> <old value as JSON>`,
 *     then `hermes config unset mcp_servers.<old>`. MEASURED at hermes-agent
 *     fdec926e: `config set` stores a JSON object as structure, and the
 *     installer then rewrites only the keys it owns (command, args);
 *   - the plugin: `hermes plugins disable <old>` when it is enabled, then
 *     `hermes plugins remove <old>`. MEASURED at fdec926e: `remove` (aliases
 *     `rm`, `uninstall`) deletes the tree and its install-metadata entry and
 *     drops the name from plugins.enabled AND plugins.disabled; both exit 1
 *     "No plugin named ..." for a name with no tree. A name listed with no tree
 *     is taken out of its list with `hermes config set plugins.<list>`. The
 *     installer then installs and enables the new plugin;
 *   - the token file: rename(2) in its own directory, so its bytes, inode and
 *     0600 mode are kept and its value never enters this process. The
 *     installer then finds the same token there and reports it unchanged.
 *
 * Old beside new in any place refuses ({@link LegacyNameConflict}), every
 * place is checked before any is changed, and the conflict names the file and
 * both names.
 */

/** `[old, new]` Hermes MCP server id. The new one is hermes.ts MCP_SERVER_NAME (asserted by test). */
export const HERMES_MCP_RENAME = ["startup-suite", "burrow"] as const;
/** `[old, new]` Hermes platform plugin name. The new one is hermes.ts PLUGIN_NAME. */
export const HERMES_PLUGIN_RENAME = ["startup-suite-platform", "burrow-platform"] as const;
/** `[old, new]` runtime token path, relative to HERMES_HOME. The new one is hermes.ts TOKEN_RELPATH. */
export const HERMES_TOKEN_RENAME = [
  join("mcp-tokens", "startup-suite-platform.runtime-token"),
  join("mcp-tokens", "burrow-platform.runtime-token"),
] as const;

/** The release from which the Hermes adapter reads only the new names. */
const HERMES_SINCE = "0.12.0";

const PLUGIN_LISTS = ["enabled", "disabled"] as const;

export type HermesPlace = "mcp_server" | "plugin" | "token_file";

/** One Hermes name the start would move. `file` is absolute. */
export interface HermesRename {
  place: HermesPlace;
  file: string;
  oldName: string;
  newName: string;
}

function presentPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pluginLists(config: Json | null): Record<(typeof PLUGIN_LISTS)[number], unknown[]> {
  const plugins = config !== null && isObject(config.plugins) ? config.plugins : {};
  const list = (k: string): unknown[] => (Array.isArray(plugins[k]) ? (plugins[k] as unknown[]) : []);
  return { enabled: list("enabled"), disabled: list("disabled") };
}

function mcpServers(config: Json | null): Json {
  return config !== null && isObject(config.mcp_servers) ? config.mcp_servers : {};
}

/**
 * What the start would rename in a Hermes home, checked in every place before
 * anything changes. Throws {@link LegacyNameConflict} when an old name sits
 * beside its new one. Read-only. `config` is config.yaml parsed (null when
 * there is none); the caller parses it so this module needs no YAML reader.
 */
export function pendingHermesRenames(home: string, config: Json | null): HermesRename[] {
  const todo: HermesRename[] = [];
  const configFile = join(home, "config.yaml");

  const [oldMcp, newMcp] = HERMES_MCP_RENAME;
  const servers = mcpServers(config);
  if (has(servers, oldMcp)) {
    if (has(servers, newMcp)) throw new LegacyNameConflict(`${configFile} mcp_servers`, oldMcp, newMcp, HERMES_SINCE);
    todo.push({ place: "mcp_server", file: configFile, oldName: oldMcp, newName: newMcp });
  }

  const [oldPlugin, newPlugin] = HERMES_PLUGIN_RENAME;
  const pluginsDir = join(home, "plugins");
  const lists = pluginLists(config);
  const oldListed = PLUGIN_LISTS.some((k) => lists[k].includes(oldPlugin));
  const oldTree = presentPath(join(pluginsDir, oldPlugin));
  if (oldTree || oldListed) {
    // The same place holding both: the plugins directory, or one list.
    if (oldTree && presentPath(join(pluginsDir, newPlugin))) throw new LegacyNameConflict(pluginsDir, oldPlugin, newPlugin, HERMES_SINCE);
    for (const k of PLUGIN_LISTS) {
      if (lists[k].includes(oldPlugin) && lists[k].includes(newPlugin)) {
        throw new LegacyNameConflict(`${configFile} plugins.${k}`, oldPlugin, newPlugin, HERMES_SINCE);
      }
    }
    todo.push({ place: "plugin", file: join(pluginsDir, oldPlugin), oldName: oldPlugin, newName: newPlugin });
  }

  const [oldToken, newToken] = HERMES_TOKEN_RENAME;
  if (presentPath(join(home, oldToken))) {
    if (presentPath(join(home, newToken))) throw new LegacyNameConflict(join(home, "mcp-tokens"), oldToken, newToken, HERMES_SINCE);
    todo.push({ place: "token_file", file: join(home, oldToken), oldName: oldToken, newName: newToken });
  }
  return todo;
}

/**
 * The old Hermes names a home still holds, one description each, for a
 * reader that must not write or refuse (the attach gate). Never throws:
 * a home holding old beside new is still a home holding old names.
 */
export function hermesLegacyNames(home: string, config: Json | null): string[] {
  const out: string[] = [];
  const [oldMcp] = HERMES_MCP_RENAME;
  if (has(mcpServers(config), oldMcp)) out.push(`${join(home, "config.yaml")} mcp_servers.${oldMcp}`);
  const [oldPlugin] = HERMES_PLUGIN_RENAME;
  const lists = pluginLists(config);
  if (presentPath(join(home, "plugins", oldPlugin))) out.push(join(home, "plugins", oldPlugin));
  for (const k of PLUGIN_LISTS) if (lists[k].includes(oldPlugin)) out.push(`${join(home, "config.yaml")} plugins.${k}: ${oldPlugin}`);
  const [oldToken] = HERMES_TOKEN_RENAME;
  if (presentPath(join(home, oldToken))) out.push(join(home, oldToken));
  return out;
}

/** How {@link renameHermesHome} reaches Hermes: its CLI (argv after the binary), and a fresh parse of config.yaml. */
export interface HermesRenameCli {
  run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readConfig(): Json | null;
}

/** Key-order-independent JSON, for comparing what Hermes stored with what was asked. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * Move a Hermes home's old names to the new ones (see the section comment for
 * how each moves). Every place is checked first: a conflict throws
 * {@link LegacyNameConflict} having changed nothing. A Hermes command that
 * fails, or that exits 0 without the effect, throws an Error naming it.
 * Returns what moved; empty for a home already renamed.
 */
export async function renameHermesHome(home: string, cli: HermesRenameCli): Promise<NameChange[]> {
  const todo = pendingHermesRenames(home, cli.readConfig());
  const changes: NameChange[] = [];
  const hermes = async (args: string[]): Promise<void> => {
    const r = await cli.run(args);
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
      throw new Error(`hermes ${args.join(" ")} exited ${r.exitCode}: ${detail}`);
    }
  };
  for (const r of todo) {
    if (r.place === "mcp_server") {
      const value = mcpServers(cli.readConfig())[r.oldName];
      const carried = isObject(value) || Array.isArray(value);
      if (carried) await hermes(["config", "set", `mcp_servers.${r.newName}`, JSON.stringify(value)]);
      await hermes(["config", "unset", `mcp_servers.${r.oldName}`]);
      const after = mcpServers(cli.readConfig());
      if (has(after, r.oldName) || (carried && canonical(after[r.newName]) !== canonical(value))) {
        throw new Error(`hermes config set/unset exited 0 but ${r.file} does not hold mcp_servers.${r.newName} in place of mcp_servers.${r.oldName}`);
      }
      changes.push({ file: r.file, what: `mcp_servers.${r.oldName} -> mcp_servers.${r.newName}` });
    } else if (r.place === "plugin") {
      const tree = presentPath(r.file);
      if (tree && pluginLists(cli.readConfig()).enabled.includes(r.oldName)) await hermes(["plugins", "disable", r.oldName]);
      if (tree) await hermes(["plugins", "remove", r.oldName]);
      // A name listed with no tree: `plugins disable/remove` cannot resolve it (measured), so the list is set without it.
      const lists = pluginLists(cli.readConfig());
      for (const k of PLUGIN_LISTS) {
        if (!lists[k].includes(r.oldName)) continue;
        await hermes(["config", "set", `plugins.${k}`, JSON.stringify(lists[k].filter((n) => n !== r.oldName))]);
      }
      const after = pluginLists(cli.readConfig());
      if (presentPath(r.file) || PLUGIN_LISTS.some((k) => after[k].includes(r.oldName))) {
        throw new Error(`hermes plugins disable/remove exited 0 but ${r.oldName} is still installed or listed`);
      }
      changes.push({ file: r.file, what: `plugin ${r.oldName} removed; the installer installs ${r.newName}` });
    } else {
      const to = join(home, r.newName);
      renameSync(r.file, to);
      changes.push({ file: to, what: `renamed from ${r.file}` });
    }
  }
  return changes;
}

/* ------------------------------------------------------------------------- */
/* OpenClaw (0.12.0)                                                          */
/* ------------------------------------------------------------------------- */

/*
 * burrow-channel-openclaw v0.9.0 renamed its plugin id and channel id. An
 * openclaw.json that a pre-0.12.0 stamp wrote holds the old ones in:
 *
 *   channels.<channel id>                       startup-suite                -> burrow
 *   bindings[].match.channel                    startup-suite                -> burrow
 *   plugins.entries.<plugin id>, plugins.allow  startup-suite-channel-plugin -> burrow-channel-plugin
 *
 * Unlike Hermes, these are NOT moved: no root a burrow-cli stamp wrote was
 * found holding them when 0.12.0 was cut, so a start REFUSES such a root
 * (writing nothing) and names the OpenClaw commands that clear it. Those
 * commands were MEASURED at OpenClaw 2026.9.9 in a throwaway
 * OPENCLAW_STATE_DIR holding the v0.8.0 plugin linked: `config unset
 * channels.<old>` removes the channel; `plugins uninstall <old> --force`
 * removes the allowlist entry and the load path but LEAVES
 * `plugins.entries.<old>` behind as `{enabled: false}`, so that is unset too;
 * `config unset bindings[N]` removes one binding. After all four the file
 * names neither old id and `config validate` passes. The next start then
 * stamps the new ids.
 *
 * An attach to a live gateway refuses nothing new: it attaches without
 * stamping (openclaw.ts), and the refusal waits for the next start.
 */

/** `[old, new]` OpenClaw plugin id. The new one is openclaw.ts PLUGIN_ID (asserted by test). */
export const OPENCLAW_PLUGIN_RENAME = ["startup-suite-channel-plugin", "burrow-channel-plugin"] as const;
/** `[old, new]` OpenClaw channel id. The new one is openclaw.ts CHANNEL_ID (asserted by test). */
export const OPENCLAW_CHANNEL_RENAME = ["startup-suite", "burrow"] as const;

/** The release from which the OpenClaw adapter reads only the new ids. */
const OPENCLAW_SINCE = "0.12.0";

/** One old id in openclaw.json, and the OpenClaw commands that clear it. */
export interface OpenclawLegacyName {
  /** Where, as a dotted path into openclaw.json. */
  path: string;
  /** Each `openclaw ...` argv (after the binary) that removes it, in order (measured; see the section comment). */
  clear: string[][];
}

/**
 * The old OpenClaw ids an openclaw.json still holds, in the order their
 * clearing commands should run. Read-only, never throws. `doc` is the parsed
 * file (null when there is none).
 */
export function openclawLegacyNames(doc: Json | null): OpenclawLegacyName[] {
  if (doc === null) return [];
  const [oldPlugin] = OPENCLAW_PLUGIN_RENAME;
  const [oldChannel] = OPENCLAW_CHANNEL_RENAME;
  const out: OpenclawLegacyName[] = [];
  const channels = isObject(doc.channels) ? doc.channels : {};
  // The channel first, while the plugin that declares it is still installed.
  if (has(channels, oldChannel)) out.push({ path: `channels.${oldChannel}`, clear: [["config", "unset", `channels.${oldChannel}`]] });
  const plugins = isObject(doc.plugins) ? doc.plugins : {};
  const inAllow = Array.isArray(plugins.allow) && plugins.allow.includes(oldPlugin);
  const inEntries = isObject(plugins.entries) && has(plugins.entries, oldPlugin);
  const uninstall = ["plugins", "uninstall", oldPlugin, "--force"];
  const unsetEntry = ["config", "unset", `plugins.entries.${oldPlugin}`];
  if (inAllow) out.push({ path: `plugins.allow[${oldPlugin}]`, clear: [uninstall] });
  if (inEntries) out.push({ path: `plugins.entries.${oldPlugin}`, clear: inAllow ? [unsetEntry] : [uninstall, unsetEntry] });
  const bindings = Array.isArray(doc.bindings) ? doc.bindings : [];
  // Highest index first: unsetting bindings[N] shifts every later one down.
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (isObject(b) && isObject(b.match) && b.match.channel === oldChannel) {
      out.push({ path: `bindings[${i}].match.channel`, clear: [["config", "unset", `bindings[${i}]`]] });
    }
  }
  return out;
}

/**
 * The refusal a start prints for a root whose openclaw.json still holds old
 * ids: the file, both spellings of each id, and the commands that clear it.
 * `env` is the variable prefix the operator needs so the commands act on THIS
 * root's state, not ~/.openclaw.
 */
export function openclawLegacyRefusal(configFile: string, names: readonly OpenclawLegacyName[], env: string): string {
  const [oldPlugin, newPlugin] = OPENCLAW_PLUGIN_RENAME;
  const [oldChannel, newChannel] = OPENCLAW_CHANNEL_RENAME;
  const commands: string[] = [];
  for (const n of names) for (const argv of n.clear) commands.push(`  ${env}openclaw ${argv.join(" ")}`);
  return [
    `${configFile} still holds the OpenClaw ids burrow-channel-openclaw used before v0.9.0 ` +
      `(${names.map((n) => n.path).join(", ")}); burrow ${OPENCLAW_SINCE} reads only ` +
      `plugin ${newPlugin} and channel ${newChannel}, in place of ${oldPlugin} and ${oldChannel}, and does not move them.`,
    "Nothing was written and nothing was started. Clear them with OpenClaw's own commands, then start the agent again:",
    ...commands,
  ].join("\n");
}
