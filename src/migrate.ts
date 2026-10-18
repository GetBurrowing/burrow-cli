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
import { dirname, resolve } from "node:path";
import { base, burrowRoot, type BaseKind, type Env } from "./xdg.ts";
import { burrowName as burrowEnvName, suiteName as suiteEnvName } from "./env_names.ts";

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
}

function emptyState(): MigrationState {
  return { version: 1, completedAt: null, moved: [], copiedLive: [], foreignLeft: [], refused: [], skipped: [] };
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
  };
}

export function serializeMigrationState(s: MigrationState): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** Done means: the full scan ran and nothing is waiting to be retried. */
export function migrationDone(s: MigrationState | null): boolean {
  return s !== null && s.completedAt !== null && s.refused.length === 0;
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

export interface MigrateDeps {
  env: Env;
  fs: MigrateFs;
  probe: LiveProbe;
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

export function liveMigrateDeps(env: Env = process.env): MigrateDeps {
  return {
    env,
    fs: liveMigrateFs(),
    probe: liveProbe(),
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
    run.writeBreadcrumbs();
    d.fs.writeAtomic(migrationStatePath(d.env), serializeMigrationState(st), 0o644);
    report(d, st, fullScan);
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
