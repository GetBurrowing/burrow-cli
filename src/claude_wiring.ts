/**
 * Claude Code's WIRING to a Burrow install — everything `suite claude` needs
 * that no other harness does:
 *
 *   plugin        the channel plugin checkout (cloned once, bun-installed)
 *   CLAUDE.md     a starting brief, never a replacement for an existing one
 *   MCP entries   `burrow-channel` and `burrow`, local scope, this folder
 *
 * This used to be steps 3-7 of `suite init`, which made init fail with
 * `ENOENT: claude` on any machine without Claude Code — a fresh Mac, or a
 * DeepSeek-only box. Now init connects the machine to the install (see
 * `src/connection.ts`) and this module is run by `suite claude`, every launch,
 * from the saved connection.
 *
 * IDEMPOTENT AND LAZY. Each piece is checked and only what is missing or stale
 * is done: a checkout already at {@link CLAUDE_CODE_CHANNEL_REF} is not touched
 * (a launch must not depend on the network), an existing CLAUDE.md is never
 * touched, and an MCP entry that already matches the saved connection is not
 * re-registered. A launch on a fully wired folder runs no git, no bun and no
 * `claude mcp` at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isLive, liveProbe, type LiveProbe } from "./migrate.ts";
import {
  CLAUDE_MD,
  conventionsFilename,
  conventionsMd,
  claudeMdPlan,
  conventionsAdvice,
  conventionsPlan,
  type ConventionsPlan,
} from "./claude_md.ts";
import type { SuiteConfig } from "./config.ts";
import { TOKEN_KEY, type CredentialStore } from "./secrets.ts";
import { row } from "./ui.ts";
import { entryAgrees } from "./env_names.ts";
import {
  LegacyNameConflict,
  pendingFileRenames,
  pendingServerIds,
  renameFiles,
  renamedEntry,
  type NameChange,
} from "./legacy_names.ts";
import {
  CHANNEL_SERVER,
  CLAUDE_CODE_CHANNEL_REF,
  LEGACY_ALIASES,
  PLUGIN_DIRNAME,
  TOOLS_SERVER,
  channelAddArgs,
  channelWsUrl,
  claudeJsonPath,
  stdioAddArgs,
  classifyPullFailure,
  connectionReport,
  ConvergenceFailed,
  defaultCheckout,
  envReference,
  noGitPrompt,
  packageCount,
  pluginRepo,
  projectKeys,
  pullRemedyLines,
  registerServers,
  scopeView,
  spinner,
  toolsAddArgs,
  toolsHttpUrl,
  verifyConnections,
  type CheckoutOutcome,
  type Runner,
} from "./commands/init.ts";
import { CLI_NAME } from "./version.ts";

type Env = Record<string, string | undefined>;

export interface WiringDeps {
  env: Env;
  run: Runner;
  /** The agent folder. Local-scope MCP entries are keyed by it. */
  cwd: string;
  isTTY: boolean;
  store: CredentialStore;
  out(line: string): void;
  /** The process probe the at-pin step consults. Defaults to the live one (migrate.ts). */
  probe?: LiveProbe;
  /** The commit the plugin checkout is held at. Defaults to {@link CLAUDE_CODE_CHANNEL_REF}. */
  pin?: string;
}

export interface WiringOptions {
  /** Override the plugin checkout location. Defaults under the data dir. */
  checkout?: string;
}

/* ------------------------------------------------------------------------- */
/* What is already registered — read from ~/.claude.json, never written       */
/* ------------------------------------------------------------------------- */

export interface McpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Re-exported from init.ts, where registration's convergence check needs it too. */
export { projectKeys };

/**
 * This folder's local-scope MCP entries, or null when `~/.claude.json` cannot
 * be read. Null means UNKNOWN, and the caller registers both — `registerServers`
 * converges on an existing entry, so the cost of not knowing is one rewrite.
 */
export function localEntries(env: Env, cwd: string): Record<string, McpEntry> | null {
  let text: string;
  try {
    text = readFileSync(claudeJsonPath(env), "utf8");
  } catch {
    return existsSync(claudeJsonPath(env)) ? null : {};
  }
  try {
    const raw = JSON.parse(text) as { projects?: Record<string, { mcpServers?: Record<string, McpEntry> }> };
    for (const key of projectKeys(cwd)) {
      const servers = raw.projects?.[key]?.mcpServers;
      if (servers !== undefined) return servers;
    }
    return {};
  } catch {
    return null;
  }
}

export type EntryState = "current" | "missing" | "stale";

export interface DesiredEntries {
  suiteUrl: string;
  runtimeId: string;
  indexPath: string;
  /** The token as it should appear in the entry, or null when not known here. */
  tokenLiteral: string | null;
  headers: Array<{ name: string; value: string | undefined }>;
}

/**
 * Does the channel entry match the saved connection?
 *
 * Compared field by field against what {@link channelAddArgs} would write. The
 * token is compared only when it is known — a machine set up before the token
 * was saved still has a working entry, and re-asking for a token to rewrite an
 * entry that is already right would be exactly the friction this removes.
 */
export function channelState(entry: McpEntry | undefined, want: DesiredEntries): EntryState {
  if (entry === undefined) return "missing";
  const env = entry.env ?? {};
  const args = entry.args ?? [];
  // Every name the entry carries must agree (see `entryAgrees`). From 0.11.0
  // an entry carries BURROW_* only: the start that renames its id also moves
  // any SUITE_* copy to BURROW_* (legacy_names.ts renamedEnv).
  if (!entryAgrees(env, "URL", channelWsUrl(want.suiteUrl))) return "stale";
  if (!entryAgrees(env, "RUNTIME_ID", want.runtimeId)) return "stale";
  if (args[args.length - 1] !== want.indexPath) return "stale";
  if (want.tokenLiteral !== null && !entryAgrees(env, "TOKEN", want.tokenLiteral)) return "stale";
  return "current";
}

/** Does the tools entry match the saved connection? Same rules as the channel. */
export function toolsState(entry: McpEntry | undefined, want: DesiredEntries): EntryState {
  if (entry === undefined) return "missing";
  if (entry.url !== toolsHttpUrl(want.suiteUrl)) return "stale";
  const headers = entry.headers ?? {};
  if (want.tokenLiteral !== null && headers.Authorization !== `Bearer ${want.tokenLiteral}`) return "stale";
  for (const h of want.headers) {
    if (!(h.name in headers)) return "stale";
    if (h.value !== undefined && headers[h.name] !== h.value) return "stale";
  }
  return "current";
}

/** The token as an entry should carry it: an env reference, the saved value, or unknown. */
export function tokenLiteralFor(config: SuiteConfig, store: CredentialStore): string | null {
  if (config.tokenEnv !== undefined) return envReference(config.tokenEnv);
  const token = store.get(TOKEN_KEY) ?? "";
  return token === "" ? null : token;
}

export interface McpPlan {
  channel: EntryState;
  tools: EntryState;
  want: DesiredEntries;
  /**
   * Legacy-alias entries (`suite`, `burrow`) this folder sees, as `scope:name`.
   * Non-empty means registration must run even when both entries are current,
   * because that is where they are removed (see `LEGACY_ALIASES`).
   */
  legacy: string[];
}

/** The `scope:name` of every legacy alias this folder sees, or [] when ~/.claude.json is unreadable. */
export function legacyAliases(env: Env, cwd: string): string[] {
  let text: string;
  try {
    text = readFileSync(claudeJsonPath(env), "utf8");
  } catch {
    return [];
  }
  const view = scopeView(text, cwd);
  if (view === null) return [];
  const found: string[] = [];
  for (const name of LEGACY_ALIASES) {
    if (view.local[name] !== undefined) found.push(`local:${name}`);
    if (view.user[name] !== undefined) found.push(`user:${name}`);
  }
  return found;
}

export function planMcp(deps: Pick<WiringDeps, "env" | "cwd" | "store">, config: SuiteConfig, checkout: string): McpPlan {
  const want: DesiredEntries = {
    suiteUrl: config.suiteUrl,
    runtimeId: config.runtimeId,
    indexPath: resolve(checkout, "src", "index.ts"),
    tokenLiteral: tokenLiteralFor(config, deps.store),
    headers: config.headerNames.map((name) => ({ name, value: deps.store.get(name) })),
  };
  const entries = localEntries(deps.env, deps.cwd);
  const legacy = legacyAliases(deps.env, deps.cwd);
  if (entries === null) return { channel: "missing", tools: "missing", want, legacy };
  return {
    channel: channelState(entries[CHANNEL_SERVER], want),
    tools: toolsState(entries[TOOLS_SERVER], want),
    want,
    legacy,
  };
}

/** True when the plan has an entry to write, or a legacy alias to remove. */
export function needsRegistration(plan: McpPlan): boolean {
  return plan.channel !== "current" || plan.tools !== "current" || plan.legacy.length > 0;
}

/* ------------------------------------------------------------------------- */
/* The 0.11.0 rename, on a START only (legacy_names.ts)                       */
/* ------------------------------------------------------------------------- */

/** What this folder still holds under its pre-0.11.0 names. */
export interface PendingRenames {
  /** `[old, new]` local-scope ids in ~/.claude.json. */
  local: Array<readonly [string, string]>;
  /** In-place file renames: config keys, `.mcp.json` ids, settings lists. */
  files: NameChange[];
}

/** True when the folder holds any pre-0.11.0 name. */
export function hasPending(p: PendingRenames): boolean {
  return p.local.length > 0 || p.files.length > 0;
}

/**
 * The pre-0.11.0 names this folder holds, without changing anything. Throws
 * {@link LegacyNameConflict} when any of them sits beside its new name.
 *
 * `configFiles` are the config files whose `suiteUrl` key moves: the folder's
 * record and the machine config.
 */
export function pendingClaudeRenames(env: Env, cwd: string, configFiles: readonly string[]): PendingRenames {
  const entries = localEntries(env, cwd);
  const local = pendingServerIds(entries as Record<string, unknown> | null, `${claudeJsonPath(env)} (local scope for ${cwd})`);
  return { local, files: pendingFileRenames(configFiles, cwd) };
}

/** The `claude mcp` argv that writes `entry` as `name` in local scope. Carries the token: never log it. */
function localAddArgv(name: string, entry: McpEntry, addJson: boolean): string[] {
  if (addJson) return ["claude", "mcp", "add-json", name, JSON.stringify(entry), "-s", "local"];
  if (entry.type === "http" && typeof entry.url === "string") {
    const argv = ["claude", "mcp", "add", name, "-s", "local", "-t", "http", entry.url];
    for (const [k, v] of Object.entries(entry.headers ?? {})) argv.push("-H", `${k}: ${v}`);
    return argv;
  }
  return stdioAddArgs(name, "local", Object.entries(entry.env ?? {}), [entry.command ?? "", ...(entry.args ?? [])]);
}

/**
 * RENAME THIS FOLDER'S PRE-0.11.0 NAMES. Call only on a path that STARTS the
 * agent, before Claude Code is launched: nothing here may run under a live one.
 *
 * Everything is checked first; a {@link LegacyNameConflict} is thrown having
 * changed nothing. Then the in-place files (config keys, `.mcp.json`, settings
 * lists), then each local-scope entry through `claude mcp remove` + `add-json`
 * (Claude Code's own writer: other agents' sessions write ~/.claude.json too).
 * A failed add puts the old entry back and throws; the launch then stops,
 * because an agent started on half its ids would load its channel under a
 * name the launch flag does not name. Returns one line per change.
 */
export async function renameClaudeNames(
  deps: Pick<WiringDeps, "env" | "run" | "cwd">,
  configFiles: readonly string[],
): Promise<string[]> {
  const pending = pendingClaudeRenames(deps.env, deps.cwd, configFiles);
  const lines = renameFiles(configFiles, deps.cwd).map((c) => row("renamed", c.file, c.what));
  if (pending.local.length === 0) return lines;

  const entries = localEntries(deps.env, deps.cwd) ?? {};
  const help = await deps.run(["claude", "mcp", "--help"], { cwd: deps.cwd });
  const addJson = /\badd-json\b/.test(`${help.stdout}\n${help.stderr}`);
  for (const [oldName, newName] of pending.local) {
    const entry = entries[oldName] as McpEntry;
    const rm = await deps.run(["claude", "mcp", "remove", oldName, "-s", "local"], { cwd: deps.cwd });
    if (rm.exitCode !== 0) {
      throw new Error(`claude mcp remove ${oldName} -s local exited ${rm.exitCode} in ${deps.cwd}: ${(rm.stderr || rm.stdout).trim()}`);
    }
    // Never printed: the argv and claude's echo of it carry the token.
    const add = await deps.run(localAddArgv(newName, renamedEntry(entry), addJson), { cwd: deps.cwd, allowSecretsInArgv: true });
    if (add.exitCode !== 0) {
      const back = await deps.run(localAddArgv(oldName, entry, addJson), { cwd: deps.cwd, allowSecretsInArgv: true });
      throw new Error(
        `claude mcp ${addJson ? "add-json" : "add"} ${newName} exited ${add.exitCode} in ${deps.cwd}; ` +
          (back.exitCode === 0 ? `${oldName} was put back as it was` : `${oldName} could NOT be put back: re-run ${CLI_NAME} init in ${deps.cwd}`),
      );
    }
    lines.push(row("renamed", `${claudeJsonPath(deps.env)} (local scope)`, `${oldName} -> ${newName}`));
  }
  // Read back: the rename is what the file says, not what we meant.
  const after = localEntries(deps.env, deps.cwd);
  const left = after === null ? null : pendingServerIds(after as Record<string, unknown>, claudeJsonPath(deps.env));
  if (left === null || left.length > 0) {
    throw new Error(`${claudeJsonPath(deps.env)} still shows a pre-0.11.0 id for ${deps.cwd} after the rename`);
  }
  return lines;
}

/** The lines a refused rename prints: the conflict, and that nothing was changed. */
export function conflictLines(error: LegacyNameConflict): string[] {
  return [`${CLI_NAME}: refusing to start: ${error.message}.`, `${CLI_NAME}: nothing was renamed.`];
}

/* ------------------------------------------------------------------------- */
/* The wiring                                                                 */
/* ------------------------------------------------------------------------- */

export interface WiringResult {
  /**
   * "failed": the clone, fetch, checkout or `bun install` failed. "held": the
   * checkout is not at the pin and was deliberately left where it is (dirty,
   * diverged, or in use). The launch went on in both (see {@link launchWarning}).
   */
  checkout: CheckoutOutcome | "present" | "failed" | "held";
  claudeMd: "write" | "skip";
  conventions: ConventionsPlan["claudeMd"];
  /** Entries written by this call, by name. Empty when both were current. */
  registered: string[];
  /** False when entries were written and then did not verify, or did not converge. */
  connected: boolean;
  /** Convergence steps that failed and were warned about instead of stopping the launch. */
  warnings: string[];
}

/**
 * A CONVERGENCE STEP THAT FAILS MUST NOT STOP THE LAUNCH (Dalton, 2026-10-17).
 * The plugin checkout (clone, `bun install`) and the alias convergence after
 * registration are both repairs: when one fails, the agent is started anyway
 * on the entries it has, and the failure is printed loudly, once, naming the
 * folder and what to run. A missing token or a refused `claude mcp add` still
 * stops the launch: those leave no entry to launch on. (`burrow init` does no
 * wiring, so it is not affected either way.)
 */
export function launchWarning(cwd: string, step: string, error: unknown): string[] {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `${CLI_NAME}: WARNING: ${step} failed for ${cwd}; launching anyway.`,
    ...detail.split("\n").map((l) => `${CLI_NAME}:   ${l}`),
    `${CLI_NAME}: run \`${CLI_NAME} doctor\` in ${cwd} to see what is left to fix.`,
  ];
}

/** The marker `bun install` leaves in node_modules: the commit its dependencies were installed for. */
export const DEPS_MARKER = ".burrow-cli-deps-ref";

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * HEAD's commit, read from the files under `<dir>/.git` WITHOUT running git:
 * a detached HEAD, or a branch through its loose ref or packed-refs. Null when
 * it cannot be read that way (a `.git` file, a missing ref), and the caller
 * then asks git. This is what lets a launch at the pin run no git at all.
 */
export function readHeadSha(dir: string): string | null {
  const gitDir = resolve(dir, ".git");
  let head: string;
  try {
    head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
  if (SHA40.test(head)) return head;
  const m = /^ref: (refs\/\S+)$/.exec(head);
  if (m === null) return null;
  const ref = m[1] as string;
  try {
    const loose = readFileSync(resolve(gitDir, ref), "utf8").trim();
    if (SHA40.test(loose)) return loose;
  } catch {}
  try {
    for (const line of readFileSync(resolve(gitDir, "packed-refs"), "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && sha !== undefined && SHA40.test(sha)) return sha;
    }
  } catch {}
  return null;
}

export type PinOutcome = "cloned" | "advanced" | "at-pin" | "held";

export interface PinResult {
  outcome: PinOutcome;
  /** Why a "held" checkout was left where it is; null otherwise. Printed as a launch warning. */
  problem: string | null;
}

const short = (sha: string): string => (sha === "" ? "an unreadable HEAD" : sha.slice(0, 7));

/**
 * HOLD THE PLUGIN CHECKOUT AT {@link CLAUDE_CODE_CHANNEL_REF}.
 *
 * Before 0.9.0 an existing checkout was used as it was and never pulled, so a
 * host stayed on whatever commit it first cloned: hive's sat at b238164
 * (2026-07-31). Now, mirroring the openclaw and hermes verbs' ensure-at-pin:
 *
 *   - HEAD is the pin: nothing. No git (HEAD is read from the files), no network.
 *   - Absent: clone, then check out the pin.
 *   - Behind the pin, clean and not in use: fetch only when the pin is not
 *     already in the object store, `checkout --detach <pin>`, `bun install`,
 *     and record the pin in node_modules/{@link DEPS_MARKER}.
 *   - Dirty, diverged (HEAD is not an ancestor of the pin, including a HEAD
 *     ahead of it), or referenced by a live process: LEFT EXACTLY WHERE IT IS
 *     and reported as `held`, with the reason. Never reset, never forced: a
 *     checkout somebody is working in, or that a running agent's channel
 *     plugin is executing from, is not this launch's to move. A later launch
 *     with nothing referencing it moves it.
 *
 * A failed clone, fetch, checkout or `bun install` throws; the caller warns and
 * launches anyway (see {@link launchWarning}).
 */
export async function ensurePluginAtPin(
  deps: Pick<WiringDeps, "env" | "run" | "isTTY" | "out">,
  dir: string,
  pin: string = CLAUDE_CODE_CHANNEL_REF,
  probe: LiveProbe = liveProbe(),
): Promise<PinResult> {
  const gitEnv = noGitPrompt(deps.env);
  const git = async (args: string[]) => await deps.run(["git", "-C", dir, ...args], { env: gitEnv });
  const detail = (r: { stdout: string; stderr: string }): string => (r.stderr || r.stdout).trim();

  /** Make sure the pin is in the object store, fetching only when it is not. */
  async function havePin(): Promise<void> {
    if ((await git(["cat-file", "-e", `${pin}^{commit}`])).exitCode === 0) return;
    const f = await git(["fetch", "--quiet", "origin"]);
    if (f.exitCode !== 0) {
      const d = detail(f);
      throw new Error(
        [`the plugin checkout at ${dir} could not fetch ${pin}:`, d, ...pullRemedyLines(classifyPullFailure(d), dir, undefined, deps.env)].join("\n"),
      );
    }
    if ((await git(["cat-file", "-e", `${pin}^{commit}`])).exitCode !== 0) {
      throw new Error(`the plugin checkout at ${dir} fetched origin and still has no commit ${pin}; is origin the channel plugin's repo?`);
    }
  }

  async function checkoutPin(): Promise<void> {
    await havePin();
    const co = await git(["checkout", "--quiet", "--detach", pin]);
    if (co.exitCode !== 0) throw new Error(`git checkout ${pin} in ${dir} failed: ${detail(co)}`);
  }

  let outcome: PinOutcome;
  let problem: string | null = null;
  if (!existsSync(resolve(dir, ".git"))) {
    const spin = spinner("plugin", deps);
    try {
      mkdirSync(dirname(dir), { recursive: true });
      const r = await deps.run(["git", "clone", pluginRepo(deps.env), dir], { env: gitEnv });
      if (r.exitCode !== 0) throw new Error(`git clone failed: ${detail(r)}`);
      await checkoutPin();
    } finally {
      spin.stop();
    }
    outcome = "cloned";
  } else {
    let head = readHeadSha(dir);
    if (head === null) {
      const r = await git(["rev-parse", "HEAD"]);
      head = r.exitCode === 0 ? r.stdout.trim() : "";
    }
    if (head === pin) {
      outcome = "at-pin";
    } else if (isLive(dir, probe())) {
      outcome = "held";
      problem =
        `the plugin checkout at ${dir} is at ${short(head)}, not the pin ${short(pin)}, and a running process uses it ` +
        `(or the process table could not be read). It is left as it is so no live agent has its code moved under it; ` +
        `a launch with nothing running from it will move it.`;
    } else {
      const st = await git(["status", "--porcelain", "--untracked-files=no"]);
      if (st.exitCode !== 0) throw new Error(`git status in ${dir} failed: ${detail(st)}`);
      if (st.stdout.trim() !== "") {
        outcome = "held";
        problem =
          `the plugin checkout at ${dir} has uncommitted changes and is at ${short(head)}, not the pin ${short(pin)}. ` +
          `It is never reset or forced: commit or stash the changes there, or move it aside, and the next launch moves it to the pin.`;
      } else {
        await havePin();
        const anc = await git(["merge-base", "--is-ancestor", "HEAD", pin]);
        if (anc.exitCode === 1) {
          outcome = "held";
          problem =
            `the plugin checkout at ${dir} is at ${short(head)}, which is not behind the pin ${short(pin)} (local commits, or ahead of it). ` +
            `It is never reset or forced: resolve it there, or move it aside, and the next launch clones the pin.`;
        } else if (anc.exitCode !== 0) {
          throw new Error(`git merge-base --is-ancestor HEAD ${pin} in ${dir} failed: ${detail(anc)}`);
        } else {
          const spin = spinner("plugin", deps);
          try {
            const co = await git(["checkout", "--quiet", "--detach", pin]);
            if (co.exitCode !== 0) throw new Error(`git checkout ${pin} in ${dir} failed: ${detail(co)}`);
          } finally {
            spin.stop();
          }
          outcome = "advanced";
        }
      }
    }
    if (outcome === "advanced") deps.out(row("plugin", PLUGIN_DIRNAME, `${short(head)} -> ${short(pin)}`));
  }
  if (outcome === "cloned") deps.out(row("plugin", PLUGIN_DIRNAME, "cloned"));

  // Dependencies: after any move, when node_modules is missing, or when the
  // marker names a different commit than the one checked out.
  const atPin = outcome !== "held";
  const marker = resolve(dir, "node_modules", DEPS_MARKER);
  const markerRef = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  const needsDeps =
    outcome === "cloned" ||
    outcome === "advanced" ||
    !existsSync(resolve(dir, "node_modules")) ||
    (atPin && markerRef !== null && markerRef !== pin);
  if (needsDeps) {
    const spin = spinner("dependencies", deps);
    let out = "";
    try {
      const r = await deps.run(["bun", "install"], { cwd: dir });
      out = `${r.stdout}\n${r.stderr}`;
      if (r.exitCode !== 0) throw new Error(`bun install failed in ${dir}`);
    } finally {
      spin.stop();
    }
    if (atPin) {
      mkdirSync(resolve(dir, "node_modules"), { recursive: true });
      writeFileSync(marker, `${pin}\n`);
    }
    deps.out(row("dependencies", packageCount(out) || "up to date", "installed"));
  }
  return { outcome, problem };
}

/** {@link PinOutcome} as the wiring result reports it. */
function checkoutField(outcome: PinOutcome): WiringResult["checkout"] {
  switch (outcome) {
    case "cloned":
      return "cloned";
    case "advanced":
      return "updated";
    case "at-pin":
      return "present";
    case "held":
      return "held";
  }
}

/**
 * CLAUDE.md: written when absent, never touched when present. The conventions
 * file is this CLI's own and is rewritten only when its content differs, so a
 * launch on a wired folder writes nothing and says nothing.
 */
function ensureClaudeMd(deps: WiringDeps): { claudeMd: "write" | "skip"; conventions: ConventionsPlan["claudeMd"] } {
  const claudeMdPath = resolve(deps.cwd, "CLAUDE.md");
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : null;
  const plan = claudeMdPlan(claudeMdPath, existing !== null);
  if (plan.action === "write") {
    writeFileSync(plan.path, CLAUDE_MD, "utf8");
    deps.out(row("CLAUDE.md", plan.path, "written"));
  }
  // BURROW_CONVENTIONS.md on a folder with neither file; an existing (or
  // linked) SUITE_CONVENTIONS.md keeps its name. Never renamed, never moved.
  const filename = conventionsFilename(existing, (name) => existsSync(resolve(deps.cwd, name)));
  const content = conventionsMd(filename);
  const conventions = conventionsPlan(resolve(deps.cwd, filename), existing);
  if (conventions.action === "write") {
    const current = existsSync(conventions.path) ? readFileSync(conventions.path, "utf8") : null;
    if (current !== content) {
      writeFileSync(conventions.path, content, "utf8");
      deps.out(row(filename, conventions.path, "written"));
      for (const line of conventionsAdvice(conventions)) deps.out(row("", "", line));
    }
  }
  return { claudeMd: plan.action, conventions: conventions.claudeMd };
}

/**
 * Wire this folder's Claude Code to the saved install.
 *
 * The caller must have put the token in `deps.store` (or set `tokenEnv`)
 * whenever {@link planMcp} reports something to register — see
 * `ensureToken` in connection.ts. Without one this throws rather than
 * registering an entry that authenticates with nothing.
 */
export async function ensureClaudeWiring(
  deps: WiringDeps,
  config: SuiteConfig,
  options: WiringOptions = {},
): Promise<WiringResult> {
  const checkoutDir = options.checkout ?? defaultCheckout(deps.env);
  const warnings: string[] = [];
  const warn = (step: string, error: unknown): void => {
    const lines = launchWarning(deps.cwd, step, error);
    warnings.push(...lines);
    for (const line of lines) deps.out(line);
  };
  let checkout: WiringResult["checkout"];
  try {
    const pinned = await ensurePluginAtPin(deps, checkoutDir, deps.pin ?? CLAUDE_CODE_CHANNEL_REF, deps.probe ?? liveProbe());
    checkout = checkoutField(pinned.outcome);
    if (pinned.problem !== null) warn("moving the channel plugin to its pin", new Error(pinned.problem));
  } catch (error) {
    warn("the channel plugin install", error);
    checkout = "failed";
  }
  const md = ensureClaudeMd(deps);

  const plan = planMcp(deps, config, checkoutDir);
  const registered: string[] = [];
  let connected = true;
  if (needsRegistration(plan)) {
    const writes = plan.channel !== "current" || plan.tools !== "current";
    const tokenLiteral = plan.want.tokenLiteral;
    // Removing an alias needs no token; writing an entry does.
    if (writes && tokenLiteral === null) {
      throw new Error(`no saved token to write into the Claude MCP entries; run ${CLI_NAME} init`);
    }
    const headers = plan.want.headers.map((h) => ({ name: h.name, value: h.value ?? "" }));
    const invocations: string[][] = [];
    if (plan.channel !== "current" && tokenLiteral !== null) {
      invocations.push(
        channelAddArgs({ suiteUrl: config.suiteUrl, runtimeId: config.runtimeId, tokenLiteral, indexPath: plan.want.indexPath }),
      );
      registered.push(CHANNEL_SERVER);
    }
    if (plan.tools !== "current" && tokenLiteral !== null) {
      invocations.push(toolsAddArgs(config.suiteUrl, tokenLiteral, headers));
      registered.push(TOOLS_SERVER);
    }
    let converged = true;
    try {
      for (const line of await registerServers(deps, invocations, config.runtimeId, config.suiteUrl)) deps.out(line);
    } catch (error) {
      if (!(error instanceof ConvergenceFailed)) throw error;
      for (const line of error.lines) deps.out(line);
      warn("MCP convergence", error);
      converged = false;
    }
    if (writes && config.tokenEnv !== undefined) {
      deps.out(row("", "", `token read from ${config.tokenEnv} at launch; export it or the channel will not authenticate`));
    }
    // WRITTEN IS NOT CONNECTED — checked only after a write, because listing
    // health-checks every server and a launch on a wired folder should not pay
    // for it. A failure here is reported, not fatal: the agent still starts.
    const report = connectionReport(await verifyConnections(deps));
    for (const line of report.lines) deps.out(line);
    connected = report.ok && converged;
  }
  return { checkout, ...md, registered, connected, warnings };
}
