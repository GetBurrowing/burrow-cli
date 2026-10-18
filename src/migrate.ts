/**
 * The one-shot move from the pre-0.9.0 `suite` directories to the `burrow` ones.
 *
 * Before 0.9.0 this CLI kept its library and plugin checkouts in
 * `<data>/suite`, its roster and session logs in `<state>/suite`, and (on any
 * host set up before 0.8.0) its config in `<config>/suite`. From 0.9.0 every
 * path resolves under `burrow`, and this module is the ONLY place that names
 * the old ones. It runs once, on the first 0.9 invocation of a verb that is
 * not machine-read (see cli.ts), and after that only reads one state file.
 *
 * THE RULES IT KEEPS
 *
 *  - One shot. When `<state>/burrow/migration.json` says the migration
 *    completed with nothing refused, a run reads that file and returns. It
 *    never re-scans the old directories, so it never fights a dev checkout of
 *    an older CLI that keeps writing `suite` paths beside it.
 *  - Atomic or recoverable. An entry moves by `rename(2)` (same filesystem),
 *    or, across filesystems, by copying to `<target>.incoming`, renaming that
 *    into place and only then removing the source. A target is never
 *    half-written.
 *  - Never orphan a running process. An entry that a live process references
 *    (its argv names the path, or its cwd is inside it) is COPIED, and the
 *    original is left exactly as it was. 0.9 reads the copy; the running
 *    process keeps the original, including the lazy imports and MCP
 *    reconnects that would break if the directory vanished under it. When the
 *    process table cannot be read, every entry counts as live.
 *  - Refusal is not failure. An entry that cannot be moved (EACCES, no space)
 *    is recorded as refused, named in a breadcrumb, and resolved at its OLD
 *    path until a later run moves it. The launch proceeds either way.
 *  - Nothing is deleted. Old directories stay, holding a breadcrumb that says
 *    what moved where. `burrow doctor` lists them and what still uses them.
 *  - Only our own entries move. The config directory is shared with things
 *    this CLI did not write (a usage hook, say), so it moves only the names
 *    in {@link CONFIG_ALLOWLIST}; everything else is left and listed.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { base, burrowRoot, home as homeOf, type BaseKind, type Env } from "./xdg.ts";
import { burrowName as burrowEnvName, suiteName as suiteEnvName } from "./env_names.ts";
import { harnessChildEnv } from "./harness_env.ts";
import { claudeJsonPath, stdioAddArgs, whichBin, type StoredEntry } from "./commands/init.ts";
import {
  LAUNCHD_LABEL,
  RESTORE_LAUNCHD_LABEL,
  RESTORE_SERVICE_NAME,
  SERVICE_NAME,
  isSupervised,
  launchdPlist,
  restoreLaunchdPlist,
  restoreUnit,
  systemdUnit,
  tmuxSupervisorArgv,
  type SupervisorInput,
} from "./supervisor.ts";

/* ------------------------------------------------------------------------- */
/* The legacy names. Nothing outside this module may spell them.             */
/* ------------------------------------------------------------------------- */

/** The directory name under each XDG base before 0.9.0. */
export const LEGACY_DIRNAME = "suite";

/**
 * Plugin checkouts are renamed while they move, to their repositories' new
 * names (the old repository names redirect). RAW on purpose: a test pins it.
 */
export const CHECKOUT_DIR_MAP: Readonly<Record<string, string>> = {
  "claude-code-suite-channel": "burrow-channel-claude-code",
  "openclaw-suite-channel": "burrow-channel-openclaw",
  "hermes-suite-channel": "burrow-channel-hermes",
};

/**
 * The config entries this CLI wrote, and so the only ones it moves.
 * `credentials.json` is connection.ts's legacy machine secrets file; the
 * per-agent credentials live inside `agents/`.
 */
export const CONFIG_ALLOWLIST: readonly string[] = ["config.json", "state.json", "watch.env", "agents", "credentials.json"];

/**
 * Data entries that are retired, never moved: `cli` is the library the 0.8
 * watch daemon is running from, and install.sh now writes `burrow/cli`.
 */
export const RETIRED_DATA_ENTRIES: readonly string[] = ["cli", "cli.incoming", "cli.previous"];

export const STATE_FILENAME = "migration.json";
export const LOCK_DIRNAME = "migration.lock";
/** Written inside an old directory. */
export const BREADCRUMB_FILENAME = "MOVED-TO-BURROW.txt";
/** Written beside an old directory that cannot be written into: `<old>.burrow-migration.txt`. */
export const BESIDE_BREADCRUMB_SUFFIX = ".burrow-migration.txt";

/** The pre-0.9 watchdog and restore units (systemd) and LaunchAgent labels. */
export const LEGACY_SERVICE_NAME = "suite-watch";
export const LEGACY_RESTORE_SERVICE_NAME = "suite-agents";
export const LEGACY_LAUNCHD_LABEL = "technology.milvenan.suite-watch";
export const LEGACY_RESTORE_LAUNCHD_LABEL = "technology.milvenan.suite-agents";
/** A swapped-out unit or plist is renamed to `<file>.retired-by-burrow-<ts>`, never deleted. */
export const RETIRED_SUFFIX = ".retired-by-burrow-";
/** A config file edited by hand (no tool writes that key) keeps `<file>.bak-burrow-<ts>`. */
export const BACKUP_SUFFIX = ".bak-burrow-";

/**
 * Where a 0.8 install put its watchdog (`watch`) and restore (`agents`) unit or
 * plist on this platform. supervisor.ts reads it too: while one is still
 * installed it does not write its own beside it.
 */
export function legacySupervisorPaths(platform: NodeJS.Platform, home: string): { watch: string | null; agents: string | null } {
  if (platform === "linux") {
    const dir = `${home}/.config/systemd/user`;
    return { watch: `${dir}/${LEGACY_SERVICE_NAME}.service`, agents: `${dir}/${LEGACY_RESTORE_SERVICE_NAME}.service` };
  }
  if (platform === "darwin") {
    const dir = `${home}/Library/LaunchAgents`;
    return { watch: `${dir}/${LEGACY_LAUNCHD_LABEL}.plist`, agents: `${dir}/${LEGACY_RESTORE_LAUNCHD_LABEL}.plist` };
  }
  return { watch: null, agents: null };
}

/** The watch.env key renamed during the move. */
const LEGACY_TELEMETRY_KEY = suiteEnvName("TELEMETRY_AUTH");
const TELEMETRY_KEY = burrowEnvName("TELEMETRY_AUTH");

export function legacyRoot(kind: BaseKind, env: Env = process.env): string {
  return resolve(base(kind, env), LEGACY_DIRNAME);
}

export function migrationStatePath(env: Env = process.env): string {
  return resolve(burrowRoot("state", env), STATE_FILENAME);
}

/** The name an entry had under the old root: the checkout map, reversed, for data. */
function legacyName(kind: BaseKind, name: string): string {
  if (kind !== "data") return name;
  for (const [from, to] of Object.entries(CHECKOUT_DIR_MAP)) if (to === name) return from;
  return name;
}

/** The name an old entry gets under the burrow root. */
function burrowName(kind: BaseKind, name: string): string {
  return kind === "data" ? (CHECKOUT_DIR_MAP[name] ?? name) : name;
}

/* ------------------------------------------------------------------------- */
/* The state file                                                            */
/* ------------------------------------------------------------------------- */

export interface MigrationEntry {
  kind: BaseKind;
  from: string;
  to: string;
  /** Why it was refused, skipped or left; how it was moved. */
  reason?: string;
}

/**
 * One recorded path or unit the second half of the migration rewrote, skipped
 * or deferred: an MCP entry in ~/.claude.json, an agent's openclaw/dsh/hermes
 * config key, a systemd unit, a LaunchAgent, or the tmux fallback watcher.
 */
export type RewriteStep = "claude-mcp" | "openclaw" | "dsh" | "hermes" | "unit" | "plist" | "tmux";

export interface RewriteEntry {
  step: RewriteStep;
  /** The file (and key) or unit file, e.g. `~/.claude.json:<dir>:suite-channel`. */
  path: string;
  from?: string;
  to?: string;
  reason?: string;
}

/** The rewrite steps run as three groups; a deferred entry re-runs its whole group. */
type RewriteGroup = "claude" | "configs" | "units";
const STEP_GROUP: Readonly<Record<RewriteStep, RewriteGroup>> = {
  "claude-mcp": "claude",
  openclaw: "configs",
  dsh: "configs",
  hermes: "configs",
  unit: "units",
  plist: "units",
  tmux: "units",
};

export interface MigrationState {
  version: 1;
  /** Set once the full scan has run, refused entries or not. */
  completedAt: string | null;
  moved: MigrationEntry[];
  copiedLive: MigrationEntry[];
  foreignLeft: MigrationEntry[];
  refused: MigrationEntry[];
  /** Target already present, or a retired entry. Recorded so the breadcrumb is complete. */
  skipped: MigrationEntry[];
  /** Set once every rewrite step has run, deferred entries or not. */
  rewritesAt: string | null;
  rewritten: RewriteEntry[];
  /** Looked at and deliberately left (a project folder that is gone, a dev checkout's agent). Not retried. */
  rewriteSkipped: RewriteEntry[];
  /** Could not be done safely yet (a guard held, a tool failed). Retried on every run. */
  deferred: RewriteEntry[];
}

function emptyState(): MigrationState {
  return {
    version: 1,
    completedAt: null,
    moved: [],
    copiedLive: [],
    foreignLeft: [],
    refused: [],
    skipped: [],
    rewritesAt: null,
    rewritten: [],
    rewriteSkipped: [],
    deferred: [],
  };
}

function rewriteList(v: unknown): RewriteEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is RewriteEntry =>
      typeof e === "object" && e !== null && typeof e.path === "string" && typeof e.step === "string" && e.step in STEP_GROUP,
  );
}

function entryList(v: unknown): MigrationEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is MigrationEntry =>
      typeof e === "object" && e !== null && typeof e.from === "string" && typeof e.to === "string" &&
      (e.kind === "config" || e.kind === "data" || e.kind === "state"),
  );
}

/** Parse a state file; null for anything that is not one (a corrupt file means "not migrated"). */
export function parseMigrationState(text: string): MigrationState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const o = raw as Partial<MigrationState> | null;
  if (o === null || typeof o !== "object" || o.version !== 1) return null;
  return {
    version: 1,
    completedAt: typeof o.completedAt === "string" ? o.completedAt : null,
    moved: entryList(o.moved),
    copiedLive: entryList(o.copiedLive),
    foreignLeft: entryList(o.foreignLeft),
    refused: entryList(o.refused),
    skipped: entryList(o.skipped),
    rewritesAt: typeof o.rewritesAt === "string" ? o.rewritesAt : null,
    rewritten: rewriteList(o.rewritten),
    rewriteSkipped: rewriteList(o.rewriteSkipped),
    deferred: rewriteList(o.deferred),
  };
}

export function serializeMigrationState(s: MigrationState): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** Done means: the full scan and every rewrite step ran, and nothing is waiting to be retried. */
export function migrationDone(s: MigrationState | null): boolean {
  return s !== null && s.completedAt !== null && s.refused.length === 0 && s.rewritesAt !== null && s.deferred.length === 0;
}

/* ------------------------------------------------------------------------- */
/* Path resolution: the one bounded dual path                                */
/* ------------------------------------------------------------------------- */

function readStateQuiet(env: Env): MigrationState | null | "absent" {
  let text: string;
  try {
    text = readFileSync(migrationStatePath(env), "utf8");
  } catch {
    return "absent";
  }
  return parseMigrationState(text);
}

/**
 * The path of `<root>/burrow/<name>` as every reader and writer should use it.
 *
 *  - Migrated (state file present): the burrow path, EXCEPT an entry the
 *    migration refused, which keeps its old path until a later run moves it.
 *  - Not yet migrated (no state file; reachable only from the verbs that skip
 *    the migration, or a run that lost the lock race): the old path when it
 *    exists and the burrow one does not. This is a read view of an unmigrated
 *    host, so `--stamp-only` on such a host finds the records it always has.
 */
export function entryPath(kind: BaseKind, name: string, env: Env = process.env): string {
  const target = resolve(burrowRoot(kind, env), name);
  const st = readStateQuiet(env);
  if (st !== "absent" && st !== null) {
    const hit = st.refused.find((e) => e.to === target);
    return hit !== undefined && existsSync(hit.from) ? hit.from : target;
  }
  if (existsSync(target)) return target;
  if (kind === "config" && !CONFIG_ALLOWLIST.includes(name)) return target;
  const old = resolve(legacyRoot(kind, env), legacyName(kind, name));
  return existsSync(old) ? old : target;
}

/**
 * A second directory to read individual files from, for a config directory
 * that was MERGED (both `<config>/suite/<name>` and `<config>/burrow/<name>`
 * existed): the old one, but only while it can still hold something 0.9 must
 * read. Null otherwise.
 *
 *  - Migrated: only when a file under it was refused.
 *  - Not yet migrated: whenever it exists beside the burrow one.
 *
 * Callers read a file from here only when the primary directory lacks it.
 */
export function legacyFallbackDir(kind: BaseKind, name: string, env: Env = process.env): string | null {
  const primary = entryPath(kind, name, env);
  const old = resolve(legacyRoot(kind, env), legacyName(kind, name));
  if (primary === old || !existsSync(old)) return null;
  const st = readStateQuiet(env);
  if (st === "absent" || st === null) return old;
  return st.refused.some((e) => e.to.startsWith(`${primary}/`)) ? old : null;
}

/* ------------------------------------------------------------------------- */
/* The process probe                                                         */
/* ------------------------------------------------------------------------- */

/** Every process's argv (joined) and cwd, as far as they can be read. */
export interface ProcessSnapshot {
  args: string[];
  cwds: string[];
}

/** Null means "could not tell", which every caller must treat as LIVE. */
export type LiveProbe = () => ProcessSnapshot | null;

export interface ProbeIo {
  platform: NodeJS.Platform;
  /** Run a command; null when it could not be started at all. */
  run(argv: string[]): { exitCode: number; stdout: string } | null;
  /** Linux: the cwd of every process in /proc; null when /proc cannot be listed. */
  procCwds(): string[] | null;
}

function liveProbeIo(): ProbeIo {
  return {
    platform: process.platform,
    run(argv) {
      try {
        const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
        return { exitCode: p.exitCode ?? 1, stdout: new TextDecoder().decode(p.stdout) };
      } catch {
        return null;
      }
    },
    procCwds() {
      let pids: string[];
      try {
        pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
      } catch {
        return null;
      }
      const out: string[] = [];
      for (const pid of pids) {
        // Another user's process, or one that exited between the listing and
        // now: unreadable, and not ours to orphan either way.
        try {
          out.push(readlinkSync(`/proc/${pid}/cwd`));
        } catch {}
      }
      return out;
    },
  };
}

/** Parse `lsof -Fn` output: every `n<path>` line is a name. */
export function parseLsofNames(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));
}

/**
 * The process probe. argv from `ps axww -o args=`; cwds from /proc on Linux
 * and `lsof -a -d cwd -Fn` on macOS, which has no /proc. Any failure, on
 * either half, is null: an unknown process table is a live one.
 */
export function liveProbe(io: ProbeIo = liveProbeIo()): LiveProbe {
  return () => {
    const ps = io.run(["ps", "axww", "-o", "args="]);
    if (ps === null || ps.exitCode !== 0) return null;
    const args = ps.stdout.split("\n").filter((l) => l !== "");
    let cwds: string[] | null;
    if (io.platform === "linux") {
      cwds = io.procCwds();
    } else if (io.platform === "darwin") {
      const lsof = io.run(["lsof", "-a", "-d", "cwd", "-Fn"]);
      cwds = lsof === null || lsof.exitCode !== 0 ? null : parseLsofNames(lsof.stdout);
    } else {
      cwds = null;
    }
    if (cwds === null) return null;
    return { args, cwds };
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a process references `path`: an argv naming it (followed by `/`,
 * whitespace, a quote or the end, so `.../deepseek` does not match
 * `.../deepseek-old`), or a cwd at or under it. A null snapshot is live.
 */
export function isLive(path: string, snap: ProcessSnapshot | null): boolean {
  if (snap === null) return true;
  const re = new RegExp(`${escapeRegExp(path)}(?=$|[/\\s"'=:])`);
  if (snap.args.some((a) => re.test(a))) return true;
  return snap.cwds.some((c) => c === path || c.startsWith(`${path}/`));
}

/* ------------------------------------------------------------------------- */
/* The filesystem, injectable so a test can count and fail every call        */
/* ------------------------------------------------------------------------- */

export interface MigrateFs {
  /** null when the file does not exist. */
  readText(path: string): string | null;
  /** null when nothing is there. */
  kindOf(path: string): "file" | "dir" | "other" | null;
  /** null when the directory does not exist or cannot be listed. */
  readdir(path: string): string[] | null;
  mkdirp(path: string): void;
  /** Make one directory; false when it already exists. */
  mkdirOne(path: string): boolean;
  rename(from: string, to: string): void;
  copyTree(from: string, to: string): void;
  remove(path: string): void;
  /** Write via a temp file and rename, at `mode`. */
  writeAtomic(path: string, text: string, mode: number): void;
  /** Permission bits, or null. */
  mode(path: string): number | null;
}

function code(err: unknown): string {
  const c = (err as { code?: unknown })?.code;
  return typeof c === "string" ? c : err instanceof Error ? err.message : String(err);
}

export function liveMigrateFs(): MigrateFs {
  return {
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if (code(err) === "ENOENT") return null;
        throw err;
      }
    },
    kindOf(path) {
      try {
        const s = lstatSync(path);
        return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
      } catch {
        return null;
      }
    },
    readdir(path) {
      try {
        return readdirSync(path).sort();
      } catch {
        return null;
      }
    },
    mkdirp: (path) => void mkdirSync(path, { recursive: true }),
    mkdirOne(path) {
      try {
        mkdirSync(path);
        return true;
      } catch (err) {
        if (code(err) === "EEXIST") return false;
        throw err;
      }
    },
    rename: (from, to) => renameSync(from, to),
    copyTree: (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    writeAtomic(path, text, mode) {
      const tmp = `${path}.burrow-tmp-${process.pid}`;
      try {
        writeFileSync(tmp, text, { mode });
        chmodSync(tmp, mode);
        renameSync(tmp, path);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    },
    mode(path) {
      try {
        return statSync(path).mode & 0o777;
      } catch {
        return null;
      }
    },
  };
}

/* ------------------------------------------------------------------------- */
/* The migration                                                             */
/* ------------------------------------------------------------------------- */

/** What a command printed. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MigrateDeps {
  env: Env;
  fs: MigrateFs;
  probe: LiveProbe;
  platform: NodeJS.Platform;
  /** For launchd's `gui/<uid>` domain. */
  uid: number;
  /**
   * Run a command (claude, openclaw, systemctl, launchctl, tmux) to completion.
   * Null when it cannot be started at all, i.e. it is not installed. Its argv
   * can carry a token (`claude mcp add-json`): never log it.
   */
  run(argv: string[], opts?: { cwd?: string; env?: Env }): CommandResult | null;
  /** The cgroup paths of a process (`/proc/<pid>/cgroup`, the part after `h:c:`); null when unreadable. */
  cgroupOf(pid: number | "self"): string[] | null;
  pid: number;
  /** True when `pid` is a running process (EPERM counts as running). */
  pidAlive(pid: number): boolean;
  now(): Date;
  /** One line to stderr. Migration never writes to stdout. */
  stderr(line: string): void;
  sleep(ms: number): void;
  /** How long to wait for another process's lock before carrying on without migrating. */
  lockWaitMs: number;
}

function liveRun(env: Env): MigrateDeps["run"] {
  return (argv, opts = {}) => {
    const childEnv = opts.env ?? env;
    const bin = argv[0] === undefined ? null : argv[0].includes("/") ? argv[0] : whichBin(argv[0], childEnv);
    if (bin === null) return null;
    try {
      const p = Bun.spawnSync([bin, ...argv.slice(1)], {
        cwd: opts.cwd,
        env: childEnv as Record<string, string>,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      return { exitCode: p.exitCode ?? 1, stdout: new TextDecoder().decode(p.stdout), stderr: new TextDecoder().decode(p.stderr) };
    } catch {
      return null;
    }
  };
}

/** `/proc/<pid>/cgroup` lines `h:c:path`, as their paths. */
export function parseCgroupFile(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(":").slice(2).join(":"));
}

export function liveMigrateDeps(env: Env = process.env): MigrateDeps {
  return {
    env,
    fs: liveMigrateFs(),
    probe: liveProbe(),
    platform: process.platform,
    uid: process.getuid?.() ?? 501,
    run: liveRun(env),
    cgroupOf(pid) {
      try {
        return parseCgroupFile(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
      } catch {
        return null;
      }
    },
    pid: process.pid,
    pidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return code(err) === "EPERM";
      }
    },
    now: () => new Date(),
    stderr: (line) => void process.stderr.write(`${line}\n`),
    sleep: (ms) => Bun.sleepSync(ms),
    lockWaitMs: 15_000,
  };
}

export interface MigrateResult {
  /** What happened: nothing to do, ran, or another process held the lock past the wait. */
  outcome: "done-already" | "ran" | "lock-busy" | "no-state-dir";
  state: MigrationState | null;
}

const PREFIX = "burrow";

/** The roster's managed lib dirs: a command running a cli.ts anywhere else is a dev checkout. */
function managedLibDirs(env: Env): string[] {
  return [resolve(legacyRoot("data", env), "cli"), resolve(burrowRoot("data", env), "cli")];
}

/**
 * Rewrite one roster string: each old managed prefix becomes its burrow
 * counterpart, checkout children through {@link CHECKOUT_DIR_MAP}.
 */
export function rewriteManagedPath(s: string, env: Env): string {
  let out = s;
  const oldData = legacyRoot("data", env);
  const newData = burrowRoot("data", env);
  for (const [from, to] of Object.entries(CHECKOUT_DIR_MAP)) {
    const re = new RegExp(`${escapeRegExp(`${oldData}/${from}`)}(?=$|[/\\s"'=:])`, "g");
    out = out.replace(re, `${newData}/${to}`);
  }
  for (const kind of ["data", "state", "config"] as const) {
    out = out.split(`${legacyRoot(kind, env)}/`).join(`${burrowRoot(kind, env)}/`);
  }
  return out;
}

/** True when an entry's command runs a `cli.ts` outside the managed lib dirs (a dev checkout). */
export function runsUnmanagedCli(command: string[], env: Env): boolean {
  const libs = managedLibDirs(env);
  return command.some((a) => (a === "cli.ts" || a.endsWith("/cli.ts")) && !libs.some((l) => a.startsWith(`${l}/`)));
}

/**
 * Rewrite a roster file's text. Every entry's `command` strings and `cwd` move
 * to burrow paths, except an entry that runs a dev checkout's cli.ts, which
 * stays byte-identical. Returns null when the text is not a roster or nothing
 * changes. Unknown fields are kept.
 */
export function rewriteRosterText(text: string, env: Env): string | null {
  let raw: { agents?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.agents)) return null;
  let changed = false;
  const agents = raw.agents.map((item: unknown) => {
    if (item === null || typeof item !== "object") return item;
    const e = item as { command?: unknown; cwd?: unknown };
    const command = Array.isArray(e.command) && e.command.every((c) => typeof c === "string") ? (e.command as string[]) : null;
    if (command !== null && runsUnmanagedCli(command, env)) return item;
    const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    if (command !== null) next.command = command.map((c) => rewriteManagedPath(c, env));
    if (typeof e.cwd === "string") next.cwd = rewriteManagedPath(e.cwd, env);
    if (JSON.stringify(next) !== JSON.stringify(item)) changed = true;
    return next;
  });
  if (!changed) return null;
  return `${JSON.stringify({ ...raw, agents }, null, 2)}\n`;
}

/** Rename the telemetry key in watch.env text; every other line is untouched. Null when nothing changes. */
export function rewriteWatchEnv(text: string): string | null {
  const lines = text.split("\n");
  const keyRe = (k: string) => new RegExp(`^(\\s*(?:export\\s+)?)${k}=`);
  if (lines.some((l) => keyRe(TELEMETRY_KEY).test(l))) return null;
  let changed = false;
  const out = lines.map((l) => {
    const m = keyRe(LEGACY_TELEMETRY_KEY).exec(l);
    if (m === null) return l;
    changed = true;
    return `${m[1]}${TELEMETRY_KEY}=${l.slice(m[0].length)}`;
  });
  return changed ? out.join("\n") : null;
}

interface Candidate {
  kind: BaseKind;
  from: string;
  to: string;
}

class Run {
  readonly st: MigrationState;
  private snap: ProcessSnapshot | null | undefined;
  /** Roots that need their breadcrumb rewritten. */
  readonly touched = new Set<BaseKind>();
  rosterChanged = false;

  constructor(
    private readonly d: MigrateDeps,
    st: MigrationState,
  ) {
    this.st = st;
  }

  private live(path: string): boolean {
    // Taken once, and only when something actually has to move.
    if (this.snap === undefined) this.snap = this.d.probe();
    return isLive(path, this.snap);
  }

  private record(list: keyof Pick<MigrationState, "moved" | "copiedLive" | "foreignLeft" | "refused" | "skipped">, e: MigrationEntry): void {
    this.st[list].push(e);
    this.touched.add(e.kind);
  }

  /** Copy `from` to `<to>.incoming`, then rename that into place. Throws, leaving no `.incoming`, on failure. */
  private copyIntoPlace(from: string, to: string): void {
    const incoming = `${to}.incoming`;
    const fs = this.d.fs;
    fs.remove(incoming);
    try {
      fs.copyTree(from, incoming);
      fs.rename(incoming, to);
    } catch (err) {
      try {
        fs.remove(incoming);
      } catch {}
      throw err;
    }
  }

  private refuse(c: Candidate, err: unknown): void {
    this.record("refused", { ...c, reason: code(err) });
  }

  /** Move, copy or refuse one entry. */
  process(c: Candidate, mergeDirs: boolean): void {
    const fs = this.d.fs;
    const fromKind = fs.kindOf(c.from);
    if (fromKind === null) return;
    const toKind = fs.kindOf(c.to);
    if (toKind !== null) {
      if (mergeDirs && fromKind === "dir" && toKind === "dir") {
        for (const name of fs.readdir(c.from) ?? []) {
          this.process({ kind: c.kind, from: resolve(c.from, name), to: resolve(c.to, name) }, false);
        }
        return;
      }
      this.record("skipped", { ...c, reason: "target exists" });
      return;
    }
    try {
      fs.mkdirp(dirname(c.to));
    } catch (err) {
      this.refuse(c, err);
      return;
    }
    if (this.live(c.from)) {
      try {
        this.copyIntoPlace(c.from, c.to);
      } catch (err) {
        this.refuse(c, err);
        return;
      }
      this.record("copiedLive", { ...c, reason: "a running process uses the original" });
      this.afterLanding(c);
      return;
    }
    try {
      fs.rename(c.from, c.to);
      this.record("moved", { ...c, reason: "rename" });
    } catch (err) {
      if (code(err) !== "EXDEV") {
        this.refuse(c, err);
        return;
      }
      try {
        this.copyIntoPlace(c.from, c.to);
      } catch (copyErr) {
        this.refuse(c, copyErr);
        return;
      }
      try {
        fs.remove(c.from);
        this.record("moved", { ...c, reason: "copy across filesystems" });
      } catch (rmErr) {
        this.record("moved", { ...c, reason: `copy across filesystems; the source could not be removed (${code(rmErr)})` });
      }
    }
    this.afterLanding(c);
  }

  /** Per-entry rewrites once an entry is at its burrow path. */
  private afterLanding(c: Candidate): void {
    const fs = this.d.fs;
    if (c.kind === "config" && c.to === resolve(burrowRoot("config", this.d.env), "watch.env")) {
      const text = fs.readText(c.to);
      const next = text === null ? null : rewriteWatchEnv(text);
      if (next !== null) {
        try {
          fs.writeAtomic(c.to, next, 0o600);
        } catch (err) {
          this.d.stderr(`${PREFIX}: could not rename the telemetry key in ${c.to} (${code(err)}); the old key still works`);
        }
      }
    }
    if (c.kind === "state" && c.to === resolve(burrowRoot("state", this.d.env), "agents.json")) {
      this.rosterChanged = true;
    }
  }

  /** The full scan: every entry of the three old roots. */
  scan(): void {
    const env = this.d.env;
    const fs = this.d.fs;
    for (const kind of ["config", "data", "state"] as const) {
      const oldRoot = legacyRoot(kind, env);
      const newRoot = burrowRoot(kind, env);
      const names = fs.readdir(oldRoot);
      if (names === null) continue;
      for (const name of names) {
        if (name === BREADCRUMB_FILENAME) continue;
        const from = resolve(oldRoot, name);
        const to = resolve(newRoot, burrowName(kind, name));
        if (kind === "config" && !CONFIG_ALLOWLIST.includes(name)) {
          this.record("foreignLeft", { kind, from, to: from, reason: "not written by this CLI" });
          continue;
        }
        if (kind === "data" && RETIRED_DATA_ENTRIES.includes(name)) {
          this.record("skipped", { kind, from, to, reason: "retired: the previous CLI library, never moved" });
          continue;
        }
        this.process({ kind, from, to }, kind === "config");
      }
    }
  }

  /** Retry what was refused before. Nothing else is looked at. */
  retry(): void {
    const pending = this.st.refused.splice(0);
    for (const e of pending) {
      this.touched.add(e.kind);
      this.process({ kind: e.kind, from: e.from, to: e.to }, e.kind === "config");
    }
  }

  rewriteRoster(): void {
    if (!this.rosterChanged) return;
    const fs = this.d.fs;
    const path = resolve(burrowRoot("state", this.d.env), "agents.json");
    const text = fs.readText(path);
    const next = text === null ? null : rewriteRosterText(text, this.d.env);
    if (next === null) return;
    try {
      fs.writeAtomic(path, next, fs.mode(path) ?? 0o644);
    } catch (err) {
      this.d.stderr(`${PREFIX}: could not rewrite the roster's recorded paths in ${path} (${code(err)})`);
    }
  }

  writeBreadcrumbs(): void {
    const env = this.d.env;
    const fs = this.d.fs;
    for (const kind of this.touched) {
      const oldRoot = legacyRoot(kind, env);
      if (fs.kindOf(oldRoot) !== "dir") continue;
      const text = breadcrumbText(this.st, kind, oldRoot);
      try {
        fs.writeAtomic(resolve(oldRoot, BREADCRUMB_FILENAME), text, 0o644);
        continue;
      } catch {}
      const beside = `${oldRoot}${BESIDE_BREADCRUMB_SUFFIX}`;
      try {
        fs.writeAtomic(beside, text, 0o644);
      } catch (err) {
        this.d.stderr(`${PREFIX}: could not leave a migration note in or beside ${oldRoot} (${code(err)})`);
      }
    }
  }
}

function under(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/** The breadcrumb for one old root: what moved where, what was copied, left and refused. */
export function breadcrumbText(st: MigrationState, kind: BaseKind, oldRoot: string): string {
  const pick = (list: MigrationEntry[]) => list.filter((e) => e.kind === kind && under(oldRoot, e.from));
  const lines: string[] = [
    `This directory belongs to the burrow CLI before 0.9.0, which kept its files under "${LEGACY_DIRNAME}".`,
    `burrow 0.9.0 and later read and write only the burrow directory; nothing here is used by them,`,
    `except an entry listed as refused below, until a later run moves it.`,
    `Nothing was deleted. Remove this directory by hand once \`burrow doctor\` shows no process still using it.`,
    "",
  ];
  const section = (title: string, list: MigrationEntry[], fmt: (e: MigrationEntry) => string) => {
    if (list.length === 0) return;
    lines.push(`${title}:`);
    for (const e of list) lines.push(`  ${fmt(e)}`);
    lines.push("");
  };
  section("moved", pick(st.moved), (e) => `${e.from} -> ${e.to}`);
  section("copied, because a running process still uses the original (left in place)", pick(st.copiedLive), (e) => `${e.from} -> ${e.to}`);
  section("left in place, not written by this CLI", pick(st.foreignLeft), (e) => e.from);
  section("refused, still used at the old path until a later run moves it", pick(st.refused), (e) => `${e.from} -> ${e.to}: ${e.reason ?? "refused"}`);
  section("skipped", pick(st.skipped), (e) => `${e.from}: ${e.reason ?? "skipped"}`);
  if (st.completedAt !== null) lines.push(`migrated: ${st.completedAt}`);
  return `${lines.join("\n")}\n`;
}

const LOCK_PIDLESS_GRACE_MS = 2_000;

/** Take the lock, waiting out a live holder and taking over a dead one. */
function acquireLock(d: MigrateDeps, lock: string): boolean {
  const deadline = d.lockWaitMs;
  let waited = 0;
  for (;;) {
    if (d.fs.mkdirOne(lock)) {
      try {
        d.fs.writeAtomic(resolve(lock, "pid"), `${d.pid}\n`, 0o644);
      } catch {}
      return true;
    }
    const pidText = d.fs.readText(resolve(lock, "pid"));
    const holder = pidText === null ? Number.NaN : Number.parseInt(pidText.trim(), 10);
    // A holder that has not written its pid yet looks like one that died
    // before writing it, so a pid-less lock is stale only after a grace period.
    const stale = pidText === null ? waited >= LOCK_PIDLESS_GRACE_MS : !Number.isFinite(holder) || !d.pidAlive(holder);
    if (stale) {
      // Renaming it aside first means only ONE of two racing takers wins.
      // A takeover that fails falls through to the bounded wait, never a spin.
      let taken = false;
      try {
        const aside = `${lock}.stale-${d.pid}`;
        d.fs.rename(lock, aside);
        d.fs.remove(aside);
        taken = true;
      } catch {}
      if (taken) continue;
    }
    if (waited >= deadline) return false;
    d.sleep(100);
    waited += 100;
  }
}

/**
 * The migration entry point, called by cli.ts before dispatch. Never throws
 * and never writes to stdout: whatever happens here, the verb still runs.
 */
export function migrateLegacyState(d: MigrateDeps): MigrateResult {
  try {
    return migrate(d);
  } catch (err) {
    d.stderr(`${PREFIX}: state migration failed (${code(err)}); continuing`);
    return { outcome: "ran", state: null };
  }
}

function readState(d: MigrateDeps): MigrationState | null {
  const text = d.fs.readText(migrationStatePath(d.env));
  return text === null ? null : parseMigrationState(text);
}

function migrate(d: MigrateDeps): MigrateResult {
  const first = readState(d);
  // THE SHORT CIRCUIT: one read, and nothing else touches the disk.
  if (migrationDone(first)) return { outcome: "done-already", state: first };

  const stateRoot = burrowRoot("state", d.env);
  try {
    d.fs.mkdirp(stateRoot);
  } catch (err) {
    d.stderr(`${PREFIX}: cannot create ${stateRoot} (${code(err)}); the old paths stay in use for now`);
    return { outcome: "no-state-dir", state: first };
  }
  const lock = resolve(stateRoot, LOCK_DIRNAME);
  if (!acquireLock(d, lock)) {
    d.stderr(`${PREFIX}: another burrow process is migrating state; continuing without waiting further`);
    return { outcome: "lock-busy", state: first };
  }
  try {
    // Re-read under the lock: the holder we waited for may have finished.
    const current = readState(d);
    if (migrationDone(current)) return { outcome: "done-already", state: current };
    const st = current ?? emptyState();
    const run = new Run(d, st);
    const fullScan = st.completedAt === null;
    if (fullScan) run.scan();
    else run.retry();
    run.rewriteRoster();
    if (st.completedAt === null) st.completedAt = d.now().toISOString();
    // The second half: paths other programs recorded, and the units. Once it
    // has run, only the groups holding a deferred entry run again.
    const firstRewrites = st.rewritesAt === null;
    const groups = new Set<RewriteGroup>(firstRewrites ? ["claude", "configs", "units"] : st.deferred.map((e) => STEP_GROUP[e.step]));
    st.deferred = st.deferred.filter((e) => !groups.has(STEP_GROUP[e.step]));
    const rewritesBefore = st.rewritten.length;
    runRewrites(d, st, groups);
    if (st.rewritesAt === null) st.rewritesAt = d.now().toISOString();
    run.writeBreadcrumbs();
    d.fs.writeAtomic(migrationStatePath(d.env), serializeMigrationState(st), 0o644);
    report(d, st, fullScan);
    reportRewrites(d, st, rewritesBefore);
    return { outcome: "ran", state: st };
  } finally {
    try {
      d.fs.remove(lock);
    } catch {}
  }
}

function report(d: MigrateDeps, st: MigrationState, fullScan: boolean): void {
  if (fullScan) {
    const total = st.moved.length + st.copiedLive.length;
    if (total + st.refused.length + st.foreignLeft.length > 0) {
      d.stderr(
        `${PREFIX}: moved state to the burrow directories: ${st.moved.length} moved, ${st.copiedLive.length} copied (in use), ` +
          `${st.foreignLeft.length} left (not ours), ${st.refused.length} refused; see ${migrationStatePath(d.env)}`,
      );
    }
  }
  for (const e of st.refused) {
    d.stderr(`${PREFIX}: could not move ${e.from} (${e.reason ?? "refused"}); still using it there until a later run moves it`);
  }
}

/* ------------------------------------------------------------------------- */
/* Leftovers, for `burrow doctor`                                            */
/* ------------------------------------------------------------------------- */

export interface Leftover {
  path: string;
  /** argv lines of live processes that still reference it (cwd matches are listed as `cwd`). */
  users: string[];
}

/** Every old root still on disk, and the live processes still using each. */
export function legacyLeftovers(env: Env = process.env, probe: LiveProbe = liveProbe()): Leftover[] {
  const roots = (["config", "data", "state"] as const).map((k) => legacyRoot(k, env)).filter((p) => existsSync(p));
  if (roots.length === 0) return [];
  const snap = probe();
  return roots.map((path) => {
    if (snap === null) return { path, users: ["(the process table could not be read)"] };
    const re = new RegExp(`${escapeRegExp(path)}(?=$|[/\\s"'=:])`);
    const users = snap.args.filter((a) => re.test(a));
    if (snap.cwds.some((c) => c === path || c.startsWith(`${path}/`))) users.push("cwd");
    return { path, users };
  });
}

/* ------------------------------------------------------------------------- */
/* The second half: paths other programs recorded, and the units             */
/* ------------------------------------------------------------------------- */
/*
 * The first half moved this CLI's own directories. Four kinds of record
 * OUTSIDE them still name the old ones, written by this CLI through another
 * program, and each is rewritten through the program that owns it wherever
 * there is one:
 *
 *  - ~/.claude.json's channel entries, by `claude mcp remove` + `add-json`
 *    (never by hand: a live Claude session rewrites that file);
 *  - an agent's openclaw.json plugins.load.paths, by `openclaw config set`;
 *  - an agent's dsh config and Hermes config.yaml, which no tool writes for
 *    those keys, so only that key is edited, a `.bak-burrow-<ts>` copy is
 *    kept, and the result is read back;
 *  - the watchdog and restore units/plists, swapped for the burrow ones.
 *
 * Nothing here runs unless a record actually names an old path, so a host with
 * nothing to rewrite runs no command at all.
 */

const requireLazy = createRequire(import.meta.url);

interface Rw {
  d: MigrateDeps;
  st: MigrationState;
  /** Compact timestamp for retired/backup file names. */
  ts: string;
}

function compactTs(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function pushUnique(list: RewriteEntry[], e: RewriteEntry): void {
  if (!list.some((x) => x.step === e.step && x.path === e.path)) list.push(e);
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

/** A regex for `path` as a whole path component prefix (not `path-old`). */
function boundedRe(path: string, flags = ""): RegExp {
  return new RegExp(`${escapeRegExp(path)}(?=$|[/\\s"'=:])`, flags);
}

/** True when `s` names something under the old data root. */
function namesLegacyData(s: string, env: Env): boolean {
  return s.includes(`${legacyRoot("data", env)}/`);
}

/** Every absolute path in `s` under the burrow data root, cut at whitespace, a quote, `=` or `:`. */
function burrowDataPaths(s: string, env: Env): string[] {
  const re = new RegExp(`${escapeRegExp(burrowRoot("data", env))}/[^\\s"'=:]*`, "g");
  return s.match(re) ?? [];
}

/** The first rewritten path that does not exist, or null when every one does. */
function missingTarget(rw: Rw, strings: string[]): string | null {
  for (const s of strings) for (const p of burrowDataPaths(s, rw.d.env)) if (rw.d.fs.kindOf(p) === null) return p;
  return null;
}

export function runRewrites(d: MigrateDeps, st: MigrationState, groups: ReadonlySet<RewriteGroup>): void {
  const rw: Rw = { d, st, ts: compactTs(d.now()) };
  // Each group is fenced: one that throws defers itself and the others still run.
  const fenced = (group: RewriteGroup, step: RewriteStep, f: () => void) => {
    if (!groups.has(group)) return;
    try {
      f();
    } catch (err) {
      pushUnique(st.deferred, { step, path: "(the whole step)", reason: `failed: ${code(err)}` });
    }
  };
  fenced("claude", "claude-mcp", () => rewriteClaudeEntries(rw));
  fenced("configs", "openclaw", () => rewriteAgentConfigs(rw));
  fenced("units", "unit", () => swapSupervisorUnits(rw));
}

function reportRewrites(d: MigrateDeps, st: MigrationState, rewrittenBefore: number): void {
  const now = st.rewritten.length - rewrittenBefore;
  if (now > 0) {
    d.stderr(`${PREFIX}: rewrote ${now} recorded path${now === 1 ? "" : "s"} or unit${now === 1 ? "" : "s"} for the burrow directories; see ${migrationStatePath(d.env)}`);
  }
  for (const e of st.deferred) {
    d.stderr(`${PREFIX}: deferred ${e.step} ${e.path}${e.reason === undefined ? "" : `: ${e.reason}`}`);
  }
}

/* ---- 1. ~/.claude.json ---------------------------------------------------- */

interface McpTarget {
  scope: "local" | "user";
  /** The project folder (local), or HOME (user): the cwd `claude mcp` runs in. */
  dir: string;
  name: string;
  entry: StoredEntry;
}

/** The channel checkout this CLI used before 0.9, which every rewritten entry names. */
function legacyChannelCheckout(env: Env): string {
  const from = Object.keys(CHECKOUT_DIR_MAP)[0] as string; // claude-code-suite-channel
  return resolve(legacyRoot("data", env), from);
}

function entryStrings(e: StoredEntry): string[] {
  return [...(typeof e.command === "string" ? [e.command] : []), ...(Array.isArray(e.args) ? e.args.filter((a) => typeof a === "string") : [])];
}

/** The entry with only its command/args paths moved to burrow. Everything else, env included, is untouched. */
function movedEntry(e: StoredEntry, env: Env): StoredEntry {
  const next: StoredEntry = { ...e };
  if (typeof e.command === "string") next.command = rewriteManagedPath(e.command, env);
  if (Array.isArray(e.args)) next.args = e.args.map((a) => (typeof a === "string" ? rewriteManagedPath(a, env) : a));
  return next;
}

/** The `claude mcp` argv that writes `entry` as `name` at `scope`. add-json when the CLI has it. */
function mcpAddArgv(name: string, scope: string, entry: StoredEntry, addJson: boolean): string[] {
  if (addJson) return ["claude", "mcp", "add-json", name, JSON.stringify(entry), "-s", scope];
  return stdioAddArgs(name, scope, Object.entries(entry.env ?? {}), [entry.command ?? "", ...(entry.args ?? [])]);
}

export function claudeMcpTargets(text: string, env: Env): McpTarget[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const re = boundedRe(legacyChannelCheckout(env));
  const named = (e: unknown): e is StoredEntry =>
    e !== null && typeof e === "object" && entryStrings(e as StoredEntry).some((s) => re.test(s));
  const out: McpTarget[] = [];
  const o = raw as { projects?: Record<string, { mcpServers?: Record<string, unknown> }>; mcpServers?: Record<string, unknown> };
  for (const [dir, proj] of Object.entries(o.projects ?? {})) {
    for (const [name, e] of Object.entries(proj?.mcpServers ?? {})) if (named(e)) out.push({ scope: "local", dir, name, entry: e });
  }
  for (const [name, e] of Object.entries(o.mcpServers ?? {})) if (named(e)) out.push({ scope: "user", dir: homeOf(env), name, entry: e });
  return out;
}

function storedAt(text: string | null, t: McpTarget): StoredEntry | undefined {
  if (text === null) return undefined;
  try {
    const o = JSON.parse(text) as { projects?: Record<string, { mcpServers?: Record<string, StoredEntry> }>; mcpServers?: Record<string, StoredEntry> };
    return t.scope === "user" ? o.mcpServers?.[t.name] : o.projects?.[t.dir]?.mcpServers?.[t.name];
  } catch {
    return undefined;
  }
}

function rewriteClaudeEntries(rw: Rw): void {
  const { d, st } = rw;
  const env = d.env;
  const file = claudeJsonPath(env);
  const label = (t: McpTarget) => `${file}:${t.scope === "user" ? "user" : t.dir}:${t.name}`;
  const defer = (path: string, reason: string) => pushUnique(st.deferred, { step: "claude-mcp", path, reason });
  let text: string | null;
  try {
    text = d.fs.readText(file);
  } catch (err) {
    defer(file, `cannot read it (${code(err)})`);
    return;
  }
  if (text === null) return;
  const targets = claudeMcpTargets(text, env);
  if (targets === null) {
    defer(file, "it is not a JSON object right now");
    return;
  }
  const from = legacyChannelCheckout(env);
  const to = rewriteManagedPath(from, env);
  let cli: { addJson: boolean } | null | undefined;
  for (const t of targets) {
    if (t.scope === "local" && d.fs.kindOf(t.dir) !== "dir") {
      pushUnique(st.rewriteSkipped, { step: "claude-mcp", path: label(t), from, to, reason: "the project folder no longer exists" });
      continue;
    }
    const next = movedEntry(t.entry, env);
    const missing = missingTarget(rw, entryStrings(next));
    if (missing !== null) {
      defer(label(t), `${missing} does not exist yet`);
      continue;
    }
    if (cli === undefined) {
      const help = d.run(["claude", "mcp", "--help"], { env });
      cli = help === null ? null : { addJson: /\badd-json\b/.test(`${help.stdout}\n${help.stderr}`) };
    }
    if (cli === null) {
      defer(label(t), "claude is not on PATH, and ~/.claude.json is only written through it");
      continue;
    }
    const opts = { cwd: t.dir, env };
    const rm = d.run(["claude", "mcp", "remove", t.name, "-s", t.scope], opts);
    if (rm === null || rm.exitCode !== 0) {
      defer(label(t), `claude mcp remove exited ${rm?.exitCode ?? "unstartable"}: ${firstLine(rm?.stderr ?? "")}`);
      continue;
    }
    // The add's output is never printed: claude may echo the entry, token and all.
    const add = d.run(mcpAddArgv(t.name, t.scope, next, cli.addJson), opts);
    if (add === null || add.exitCode !== 0) {
      const back = d.run(mcpAddArgv(t.name, t.scope, t.entry, cli.addJson), opts);
      const restored = back !== null && back.exitCode === 0;
      defer(
        label(t),
        `claude mcp ${cli.addJson ? "add-json" : "add"} exited ${add?.exitCode ?? "unstartable"}; the original entry was ${restored ? "restored" : `NOT restored: run ${PREFIX} claude in ${t.dir}`}`,
      );
      continue;
    }
    const back = storedAt(d.fs.readText(file), t);
    const ok =
      back !== undefined &&
      JSON.stringify(entryStrings(back)) === JSON.stringify(entryStrings(next)) &&
      missingTarget(rw, entryStrings(back)) === null;
    if (!ok) {
      defer(label(t), "claude exited 0 but reading ~/.claude.json back does not show the new path");
      continue;
    }
    st.rewritten.push({ step: "claude-mcp", path: label(t), from, to, reason: cli.addJson ? "claude mcp add-json" : "claude mcp add" });
  }
}

/* ---- 2. agents' openclaw, dsh and hermes configs -------------------------- */

interface AgentRoots {
  roots: string[];
  hermesHomes: string[];
  /** Roots of roster entries a dev checkout launched: their launcher owns their paths. */
  devRoots: string[];
}

function flagValues(command: string[], flag: string, cwd: string): string[] {
  const out: string[] = [];
  command.forEach((a, i) => {
    if (a === flag && command[i + 1] !== undefined) out.push(resolve(cwd, command[i + 1] as string));
    else if (a.startsWith(`${flag}=`)) out.push(resolve(cwd, a.slice(flag.length + 1)));
  });
  return out;
}

/** Agent roots, from the roster and the per-agent connection records. */
function agentRoots(rw: Rw): AgentRoots {
  const { d } = rw;
  const env = d.env;
  const roots = new Set<string>();
  const hermes = new Set<string>();
  const dev = new Set<string>();
  for (const roster of [resolve(burrowRoot("state", env), "agents.json"), resolve(legacyRoot("state", env), "agents.json")]) {
    const text = d.fs.readText(roster);
    if (text === null) continue;
    let agents: unknown;
    try {
      agents = (JSON.parse(text) as { agents?: unknown }).agents;
    } catch {
      continue;
    }
    if (!Array.isArray(agents)) continue;
    for (const a of agents as Array<{ command?: unknown; cwd?: unknown }>) {
      if (typeof a?.cwd !== "string" || !Array.isArray(a.command) || !a.command.every((c) => typeof c === "string")) continue;
      const command = a.command as string[];
      const these = [a.cwd, ...flagValues(command, "--root", a.cwd)];
      const homes = flagValues(command, "--hermes-home", a.cwd);
      const target = runsUnmanagedCli(command, env) ? dev : roots;
      for (const r of these) target.add(r);
      if (target === roots) for (const h of homes) hermes.add(h);
    }
    break;
  }
  for (const agentsDir of [resolve(burrowRoot("config", env), "agents"), resolve(legacyRoot("config", env), "agents")]) {
    for (const name of d.fs.readdir(agentsDir) ?? []) {
      if (!name.endsWith(".json") || name.endsWith(".credentials.json")) continue;
      const text = d.fs.readText(resolve(agentsDir, name));
      try {
        const dir = (JSON.parse(text ?? "null") as { dir?: unknown } | null)?.dir;
        if (typeof dir === "string" && dir !== "") roots.add(resolve(dir));
      } catch {}
    }
  }
  for (const r of dev) roots.delete(r);
  for (const r of roots) hermes.add(join(r, ".hermes"));
  return { roots: [...roots].sort(), hermesHomes: [...hermes].sort(), devRoots: [...dev].sort() };
}

/** Write `next` over `path` by hand: a `.bak-burrow-<ts>` copy first, same mode, then read it back. */
function editByHand(rw: Rw, path: string, next: string, holds: (text: string) => boolean): string | null {
  const fs = rw.d.fs;
  const bak = `${path}${BACKUP_SUFFIX}${rw.ts}`;
  try {
    if (fs.kindOf(bak) === null) fs.copyTree(path, bak);
    fs.writeAtomic(path, next, fs.mode(path) ?? 0o600);
  } catch (err) {
    return `could not write it (${code(err)})`;
  }
  const back = fs.readText(path);
  return back !== null && holds(back) ? null : "written, but reading it back does not show the new value";
}

function rewriteAgentConfigs(rw: Rw): void {
  const { roots, hermesHomes, devRoots } = agentRoots(rw);
  for (const root of roots) {
    rewriteOpenclaw(rw, root, false);
    rewriteDsh(rw, root, false);
  }
  for (const home of hermesHomes) rewriteHermes(rw, home, false);
  // A dev checkout's agent: looked at, so the evidence says what was left, and never written.
  for (const root of devRoots) {
    rewriteOpenclaw(rw, root, true);
    rewriteDsh(rw, root, true);
    rewriteHermes(rw, join(root, ".hermes"), true);
  }
}

const DEV_REASON = "a dev checkout launched this agent; its launcher owns these paths";

/** openclaw.json, the file `openclaw config set` writes (openclaw.ts configPathFor). */
function rewriteOpenclaw(rw: Rw, root: string, dev: boolean): void {
  const { d, st } = rw;
  const env = d.env;
  const stateDir = join(root, ".openclaw");
  const file = join(stateDir, "openclaw.json");
  const text = d.fs.readText(file);
  if (text === null) return;
  const key = "plugins.load.paths";
  const label = `${file}:${key}`;
  const read = (t: string): unknown[] | null => {
    try {
      const v = (JSON.parse(t) as { plugins?: { load?: { paths?: unknown } } })?.plugins?.load?.paths;
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const paths = read(text);
  if (paths === null || !paths.some((p) => typeof p === "string" && namesLegacyData(p, env))) return;
  const next = paths.map((p) => (typeof p === "string" ? rewriteManagedPath(p, env) : p));
  const entry = { step: "openclaw" as const, path: label, from: JSON.stringify(paths), to: JSON.stringify(next) };
  if (dev) return pushUnique(st.rewriteSkipped, { ...entry, reason: DEV_REASON });
  const missing = missingTarget(rw, next.filter((p): p is string => typeof p === "string"));
  if (missing !== null) return pushUnique(st.deferred, { ...entry, reason: `${missing} does not exist yet` });
  const holds = (t: string) => JSON.stringify(read(t)) === JSON.stringify(next);
  const managed = join(burrowRoot("data", env), "openclaw", "node_modules", ".bin", "openclaw");
  const bin = d.fs.kindOf(managed) === "file" ? managed : "openclaw";
  const childEnv = harnessChildEnv(env, { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: file, OPENCLAW_HOME: root });
  const r = d.run([bin, "config", "set", key, JSON.stringify(next), "--strict-json"], { cwd: root, env: childEnv });
  if (r === null) {
    // No openclaw to write through: only that key, by hand.
    const doc = JSON.parse(text) as { plugins: { load: { paths: unknown[] } } };
    doc.plugins.load.paths = next;
    const failed = editByHand(rw, file, `${JSON.stringify(doc, null, 2)}\n`, holds);
    if (failed !== null) return pushUnique(st.deferred, { ...entry, reason: failed });
    st.rewritten.push({ ...entry, reason: `edited by hand (openclaw not found); backup ${file}${BACKUP_SUFFIX}${rw.ts}` });
    return;
  }
  if (r.exitCode !== 0) return pushUnique(st.deferred, { ...entry, reason: `openclaw config set exited ${r.exitCode}: ${firstLine(r.stderr || r.stdout)}` });
  const back = d.fs.readText(file);
  if (back === null || !holds(back)) return pushUnique(st.deferred, { ...entry, reason: "openclaw config set exited 0 but openclaw.json does not hold the value" });
  st.rewritten.push({ ...entry, reason: "openclaw config set" });
}

/** `<root>/.dsh/*.yml|yaml|json`: the deepseek verb renders suite.patch.yml naming `<data>/.../deepseek`. */
function rewriteDsh(rw: Rw, root: string, dev: boolean): void {
  const { d, st } = rw;
  const env = d.env;
  const dir = join(root, ".dsh");
  const oldHarness = resolve(legacyRoot("data", env), "deepseek");
  const newHarness = resolve(burrowRoot("data", env), "deepseek");
  for (const name of d.fs.readdir(dir) ?? []) {
    if (!/\.(ya?ml|json)$/.test(name)) continue;
    const file = join(dir, name);
    if (d.fs.kindOf(file) !== "file") continue;
    const text = d.fs.readText(file);
    if (text === null || !boundedRe(oldHarness).test(text)) continue;
    const next = text.replace(boundedRe(oldHarness, "g"), newHarness);
    const entry = { step: "dsh" as const, path: file, from: oldHarness, to: newHarness };
    if (dev) {
      pushUnique(st.rewriteSkipped, { ...entry, reason: DEV_REASON });
      continue;
    }
    const missing = missingTarget(rw, [next]);
    if (missing !== null) {
      pushUnique(st.deferred, { ...entry, reason: `${missing} does not exist yet` });
      continue;
    }
    // No tool writes it but the verb's own renderer, which needs the agent's
    // connection; only the harness path changes, by hand.
    const failed = editByHand(rw, file, next, (t) => t === next);
    if (failed !== null) pushUnique(st.deferred, { ...entry, reason: failed });
    else st.rewritten.push({ ...entry, reason: `edited by hand; backup ${file}${BACKUP_SUFFIX}${rw.ts}` });
  }
}

type YamlDoc = { errors: unknown[]; setIn(path: unknown[], value: unknown): void; toJS(): unknown; toString(): string };

/** Every string in a parsed YAML tree that names an old data path, with its key path. */
function legacyStrings(node: unknown, env: Env, at: (string | number)[] = []): Array<{ path: (string | number)[]; value: string }> {
  if (typeof node === "string") return namesLegacyData(node, env) ? [{ path: at, value: node }] : [];
  if (Array.isArray(node)) return node.flatMap((v, i) => legacyStrings(v, env, [...at, i]));
  if (node !== null && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => legacyStrings(v, env, [...at, k]));
  return [];
}

function lookupIn(node: unknown, path: (string | number)[]): unknown {
  let n: unknown = node;
  for (const p of path) {
    if (n === null || typeof n !== "object") return undefined;
    n = (n as Record<string | number, unknown>)[p];
  }
  return n;
}

/**
 * `<HERMES_HOME>/config.yaml`. The keys that can name a data path are written
 * by the channel installer, not by `hermes config set`, so there is no tool to
 * write them through: only those values change, through yaml's document model
 * so every other line keeps its formatting.
 */
function rewriteHermes(rw: Rw, hermesHome: string, dev: boolean): void {
  const { d, st } = rw;
  const env = d.env;
  const file = join(hermesHome, "config.yaml");
  const text = d.fs.readText(file);
  if (text === null || !namesLegacyData(text, env)) return;
  const yaml = requireLazy("yaml") as { parseDocument(t: string): YamlDoc; parse(t: string): unknown };
  const doc = yaml.parseDocument(text);
  if (doc.errors.length > 0) return pushUnique(st.deferred, { step: "hermes", path: file, reason: "config.yaml does not parse" });
  const hits = legacyStrings(doc.toJS(), env);
  if (hits.length === 0) return;
  const changes = hits.map((h) => ({ ...h, next: rewriteManagedPath(h.value, env) }));
  const entries = changes.map((c) => ({ step: "hermes" as const, path: `${file}:${c.path.join(".")}`, from: c.value, to: c.next }));
  if (dev) {
    for (const e of entries) pushUnique(st.rewriteSkipped, { ...e, reason: DEV_REASON });
    return;
  }
  const missing = missingTarget(rw, changes.map((c) => c.next));
  if (missing !== null) {
    for (const e of entries) pushUnique(st.deferred, { ...e, reason: `${missing} does not exist yet` });
    return;
  }
  for (const c of changes) doc.setIn(c.path, c.next);
  const holds = (t: string) => {
    try {
      const parsed = yaml.parse(t);
      return changes.every((c) => lookupIn(parsed, c.path) === c.next);
    } catch {
      return false;
    }
  };
  const failed = editByHand(rw, file, String(doc), holds);
  for (const e of entries) {
    if (failed !== null) pushUnique(st.deferred, { ...e, reason: failed });
    else st.rewritten.push({ ...e, reason: `edited by hand; backup ${file}${BACKUP_SUFFIX}${rw.ts}` });
  }
}

/* ---- 3. units and plists -------------------------------------------------- */

type Which = "watch" | "agents";

/** The binary, interval, PATH and LANG a 0.8 unit or plist was written with, so the new one keeps them. */
export function unitInputFrom(text: string, platform: NodeJS.Platform, home: string, env: Env): SupervisorInput {
  let binary: string | undefined;
  let interval: number | undefined;
  let path: string | undefined;
  let lang: string | undefined;
  if (platform === "darwin") {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] as string);
    binary = strings[0];
    const i = strings.indexOf("--interval");
    if (i >= 0) interval = Number(strings[i + 1]);
    path = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
    lang = /<key>LANG<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  } else {
    const exec = /^ExecStart=(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
    binary = exec[0];
    const i = exec.indexOf("--interval");
    if (i >= 0) interval = Number(exec[i + 1]);
    path = /^Environment=PATH=(.*)$/m.exec(text)?.[1];
    lang = /^Environment=LANG=(.*)$/m.exec(text)?.[1];
  }
  return {
    platform,
    home,
    binary: binary !== undefined && binary.startsWith("/") ? binary : `${home}/.local/bin/suite`,
    intervalSeconds: interval !== undefined && Number.isFinite(interval) && interval >= 10 ? interval : 60,
    inheritedPath: path,
    inheritedLocale: lang,
    env,
  };
}

function beside(rw: Rw, legacy: string, lines: string[]): void {
  try {
    rw.d.fs.writeAtomic(`${legacy}${BESIDE_BREADCRUMB_SUFFIX}`, `${lines.join("\n")}\n`, 0o644);
  } catch {}
}

function swapSupervisorUnits(rw: Rw): void {
  const { d } = rw;
  if (d.platform !== "linux" && d.platform !== "darwin") return;
  const home = homeOf(d.env);
  const legacy = legacySupervisorPaths(d.platform, home);
  for (const which of ["watch", "agents"] as const) {
    const path = legacy[which];
    if (path === null) continue;
    if (d.platform === "linux") swapSystemdUnit(rw, which, path);
    else swapPlist(rw, which, path);
  }
  swapTmuxFallback(rw, legacy.watch as string);
}

/** `systemctl --user show -p <prop> --value <unit>`, trimmed; null when it cannot be read. */
function unitProperty(d: MigrateDeps, unit: string, prop: string): string | null {
  const r = d.run(["systemctl", "--user", "show", "-p", prop, "--value", unit], { env: d.env });
  if (r === null || r.exitCode !== 0) return null;
  return r.stdout.trim().replace(new RegExp(`^${prop}=`), "");
}

/**
 * GUARD B: the unit this process runs inside is never stopped from inside it.
 * A daemon that stops its own unit dies mid-migration.
 */
function selfInUnit(d: MigrateDeps, unit: string, which: Which): string | null {
  if (which === "watch" && isSupervised(d.env)) return "this process is the watch daemon";
  const inv = d.env.INVOCATION_ID;
  if (inv !== undefined && inv !== "" && unitProperty(d, unit, "InvocationID") === inv) return `this process runs inside ${unit}`;
  const cg = unitProperty(d, unit, "ControlGroup");
  const mine = d.cgroupOf("self");
  if (cg !== null && cg !== "" && mine !== null && mine.some((p) => under(cg, p))) return `this process runs inside ${unit}'s cgroup ${cg}`;
  return null;
}

/** Every tmux server pid and pane pid on the default socket; [] when there is no server. */
function tmuxPids(d: MigrateDeps): number[] {
  const pids = new Set<number>();
  for (const argv of [
    ["tmux", "list-sessions", "-F", "#{pid}"],
    ["tmux", "list-panes", "-a", "-F", "#{pane_pid}"],
  ]) {
    const r = d.run(argv, { env: d.env });
    if (r === null || r.exitCode !== 0) continue;
    for (const l of r.stdout.split("\n")) {
      const n = Number.parseInt(l.trim(), 10);
      if (Number.isFinite(n) && n > 0) pids.add(n);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * GUARD A: stopping a unit kills its whole cgroup by default, so a unit that
 * holds a tmux server or an agent pane is never stopped. Anything that cannot
 * be read counts as held.
 */
function tmuxInUnit(d: MigrateDeps, unit: string): string | null {
  const cg = unitProperty(d, unit, "ControlGroup");
  if (cg === null || cg === "") return `the control group of ${unit} could not be read`;
  for (const pid of tmuxPids(d)) {
    const groups = d.cgroupOf(pid);
    if (groups === null) return `the cgroup of tmux pid ${pid} could not be read`;
    if (groups.some((p) => under(cg, p))) return `tmux pid ${pid} is inside ${unit}'s cgroup ${cg}`;
  }
  return null;
}

function writeUnitFile(rw: Rw, path: string, text: string): void {
  rw.d.fs.mkdirp(dirname(path));
  rw.d.fs.writeAtomic(path, text, 0o644);
}

function swapSystemdUnit(rw: Rw, which: Which, legacy: string): void {
  const { d, st } = rw;
  const text = d.fs.readText(legacy);
  if (text === null) return;
  const oldUnit = basename(legacy);
  const newUnit = `${which === "watch" ? SERVICE_NAME : RESTORE_SERVICE_NAME}.service`;
  const newPath = join(dirname(legacy), newUnit);
  const input = unitInputFrom(text, "linux", homeOf(d.env), d.env);
  const newText = which === "watch" ? systemdUnit(input) : restoreUnit(input);
  const sc = (...args: string[]) => d.run(["systemctl", "--user", ...args], { env: d.env });
  const retired = `${legacy}${RETIRED_SUFFIX}${rw.ts}`;
  const entry = { step: "unit" as const, path: legacy, from: oldUnit, to: newUnit };
  const defer = (reason: string) => {
    pushUnique(st.deferred, { ...entry, reason });
    beside(rw, legacy, [
      `burrow 0.9 has not swapped ${oldUnit} for ${newUnit} yet: ${reason}.`,
      `${newPath} is written and NOT enabled; ${oldUnit} is untouched. Every later burrow run retries.`,
    ]);
  };

  const en = sc("is-enabled", oldUnit);
  if (en === null) {
    // No systemctl at all: the unit is a file no service manager runs.
    writeUnitFile(rw, newPath, newText);
    d.fs.rename(legacy, retired);
    st.rewritten.push({ ...entry, reason: `no systemctl, so nothing ran it; written ${newUnit}, retired the old file to ${retired}` });
    return;
  }
  const enabled = /^enabled/.test(en.stdout.trim());
  const act = sc("is-active", oldUnit);
  const active = act !== null && ["active", "activating", "reloading"].includes(act.stdout.trim());

  if (active) {
    const self = selfInUnit(d, oldUnit, which);
    const held = self === null ? tmuxInUnit(d, oldUnit) : null;
    const reason = self ?? held;
    if (reason !== null) {
      writeUnitFile(rw, newPath, newText);
      sc("daemon-reload");
      defer(self !== null ? `${reason}; it cannot stop its own unit, so the next burrow run outside it swaps it` : `${reason}; stopping it would take tmux down`);
      if (self !== null) d.stderr(`${PREFIX}: left ${oldUnit} running (${self}); the next burrow run outside it swaps it for ${newUnit}`);
      return;
    }
  }

  writeUnitFile(rw, newPath, newText);
  sc("daemon-reload");
  if (enabled) {
    const e = sc("enable", newUnit);
    if (e === null || e.exitCode !== 0) return defer(`systemctl enable ${newUnit} exited ${e?.exitCode ?? "unstartable"}: ${firstLine(e?.stderr ?? "")}`);
  }
  if (active) {
    // Stop first, start second: the two never run at once.
    const stop = sc("stop", oldUnit);
    if (stop === null || stop.exitCode !== 0) return defer(`systemctl stop ${oldUnit} exited ${stop?.exitCode ?? "unstartable"}: ${firstLine(stop?.stderr ?? "")}`);
    const start = sc("start", newUnit);
    if (start === null || start.exitCode !== 0) {
      const back = sc("start", oldUnit);
      return defer(
        `systemctl start ${newUnit} exited ${start?.exitCode ?? "unstartable"}: ${firstLine(start?.stderr ?? "")}; ${oldUnit} was ${back !== null && back.exitCode === 0 ? "started again" : "NOT started again"}`,
      );
    }
  }
  if (enabled) sc("disable", oldUnit);
  d.fs.rename(legacy, retired);
  sc("daemon-reload");
  st.rewritten.push({ ...entry, reason: `was ${enabled ? "enabled" : "disabled"} and ${active ? "active" : "inactive"}; old file retired to ${retired}` });
}

function swapPlist(rw: Rw, which: Which, legacy: string): void {
  const { d, st } = rw;
  const text = d.fs.readText(legacy);
  if (text === null) return;
  const oldLabel = which === "watch" ? LEGACY_LAUNCHD_LABEL : LEGACY_RESTORE_LAUNCHD_LABEL;
  const newLabel = which === "watch" ? LAUNCHD_LABEL : RESTORE_LAUNCHD_LABEL;
  const newPath = join(dirname(legacy), `${newLabel}.plist`);
  const input = unitInputFrom(text, "darwin", homeOf(d.env), d.env);
  const newText = which === "watch" ? launchdPlist(input) : restoreLaunchdPlist(input);
  const domain = `gui/${d.uid}`;
  const lc = (...args: string[]) => d.run(["launchctl", ...args], { env: d.env });
  const retired = `${legacy}${RETIRED_SUFFIX}${rw.ts}`;
  const entry = { step: "plist" as const, path: legacy, from: oldLabel, to: newLabel };
  const defer = (reason: string) => {
    pushUnique(st.deferred, { ...entry, reason });
    beside(rw, legacy, [`burrow 0.9 has not swapped ${oldLabel} for ${newLabel} yet: ${reason}.`, "Every later burrow run retries."]);
  };
  const pr = lc("print", `${domain}/${oldLabel}`);
  const loaded = pr !== null && pr.exitCode === 0;
  if (loaded && which === "watch" && isSupervised(d.env)) {
    // GUARD B. Not even the new plist is written: launchd would load both at the next login.
    d.stderr(`${PREFIX}: left ${oldLabel} running (this process is the watch daemon); the next burrow run outside it swaps it for ${newLabel}`);
    return defer("this process is the watch daemon; it cannot boot out its own job");
  }
  writeUnitFile(rw, newPath, newText);
  if (loaded) {
    const out = lc("bootout", `${domain}/${oldLabel}`);
    if (out === null || out.exitCode !== 0) {
      d.fs.remove(newPath);
      return defer(`launchctl bootout exited ${out?.exitCode ?? "unstartable"}: ${firstLine(out?.stderr ?? "")}`);
    }
    // The restore job is not bootstrapped now: its RunAtLoad would run a
    // restore unattended. Its plist loads at the next login, as the old one did.
    if (which === "watch") {
      const boot = lc("bootstrap", domain, newPath);
      if (boot === null || boot.exitCode !== 0) {
        const back = lc("bootstrap", domain, legacy);
        d.fs.remove(newPath);
        return defer(
          `launchctl bootstrap ${newLabel} exited ${boot?.exitCode ?? "unstartable"}: ${firstLine(boot?.stderr ?? "")}; ${oldLabel} was ${back !== null && back.exitCode === 0 ? "bootstrapped again" : "NOT bootstrapped again"}`,
        );
      }
    }
  }
  d.fs.rename(legacy, retired);
  st.rewritten.push({ ...entry, reason: `was ${loaded ? "loaded" : "not loaded"}; old plist retired to ${retired}` });
}

/**
 * The no-GUI / no-user-systemd fallback: a tmux session named for the unit.
 * Only on a host where 0.8 installed a watchdog (its unit or plist file, live
 * or retired, is there), so a throwaway HOME never reaches the real tmux. Only
 * the watcher's own session is killed, and it is killed before the new one is
 * created.
 */
function swapTmuxFallback(rw: Rw, legacyWatch: string): void {
  const { d, st } = rw;
  const dir = dirname(legacyWatch);
  const name = basename(legacyWatch);
  const retired = (d.fs.readdir(dir) ?? []).filter((n) => n.startsWith(`${name}${RETIRED_SUFFIX}`)).sort();
  const source = d.fs.kindOf(legacyWatch) === "file" ? legacyWatch : retired.length > 0 ? join(dir, retired[retired.length - 1] as string) : null;
  if (source === null) return;
  const tmux = (...args: string[]) => d.run(["tmux", ...args], { env: d.env });
  const has = tmux("has-session", "-t", `=${LEGACY_SERVICE_NAME}`);
  if (has === null || has.exitCode !== 0) return;
  const entry = { step: "tmux" as const, path: `tmux session ${LEGACY_SERVICE_NAME}`, from: LEGACY_SERVICE_NAME, to: SERVICE_NAME };
  if (isSupervised(d.env)) {
    d.stderr(`${PREFIX}: left tmux session ${LEGACY_SERVICE_NAME} running (this process is the watch daemon); the next burrow run outside it swaps it for ${SERVICE_NAME}`);
    return pushUnique(st.deferred, { ...entry, reason: "this process is the watch daemon" });
  }
  const input = unitInputFrom(d.fs.readText(source) ?? "", d.platform, homeOf(d.env), d.env);
  const [, create] = tmuxSupervisorArgv(input.binary, input.intervalSeconds) as [string[], string[]];
  const managed =
    d.platform === "linux"
      ? d.run(["systemctl", "--user", "is-active", `${SERVICE_NAME}.service`], { env: d.env })?.stdout.trim() === "active"
      : d.run(["launchctl", "print", `gui/${d.uid}/${LAUNCHD_LABEL}`], { env: d.env })?.exitCode === 0;
  const kill = tmux("kill-session", "-t", `=${LEGACY_SERVICE_NAME}`);
  if (kill === null || kill.exitCode !== 0) return pushUnique(st.deferred, { ...entry, reason: `tmux kill-session exited ${kill?.exitCode ?? "unstartable"}` });
  if (managed) {
    st.rewritten.push({ ...entry, reason: `killed; ${SERVICE_NAME} already runs under the service manager` });
    return;
  }
  if (tmux("has-session", "-t", `=${SERVICE_NAME}`)?.exitCode === 0) {
    st.rewritten.push({ ...entry, reason: `killed; tmux session ${SERVICE_NAME} already exists` });
    return;
  }
  const made = d.run(create, { env: d.env });
  if (made === null || made.exitCode !== 0) {
    const old = create.map((a) => (a === SERVICE_NAME ? LEGACY_SERVICE_NAME : a));
    const back = d.run(old, { env: d.env });
    return pushUnique(st.deferred, {
      ...entry,
      reason: `tmux new-session ${SERVICE_NAME} exited ${made?.exitCode ?? "unstartable"}; ${LEGACY_SERVICE_NAME} was ${back !== null && back.exitCode === 0 ? "started again" : "NOT started again"}`,
    });
  }
  st.rewritten.push({ ...entry, reason: "killed, then created" });
}
