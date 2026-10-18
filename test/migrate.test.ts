/**
 * The one-shot state migration (src/migrate.ts). Every case runs against a
 * throwaway mkdtemp HOME laid out like a v0.8.0 host, with the process probe
 * injected, so nothing here reads or writes a real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldMigrate, usage } from "../src/cli.ts";
import {
  BESIDE_BREADCRUMB_SUFFIX,
  BREADCRUMB_FILENAME,
  CHECKOUT_DIR_MAP,
  CONFIG_ALLOWLIST,
  entryPath,
  isLive,
  legacyLeftovers,
  liveMigrateFs,
  liveProbe,
  migrateLegacyState,
  migrationStatePath,
  parseLsofNames,
  parseMigrationState,
  rewriteRosterText,
  rewriteWatchEnv,
  type LiveProbe,
  type MigrateDeps,
  type MigrateFs,
  type MigrationState,
  type ProbeIo,
  type ProcessSnapshot,
} from "../src/migrate.ts";
import { configPath, dataEntry, stateEntry } from "../src/paths.ts";
import { defaultCheckout, PLUGIN_DIRNAME } from "../src/commands/init.ts";
import { rosterPath } from "../src/roster.ts";
import { envFilePath } from "../src/supervisor.ts";
import { VERSION } from "../src/version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const h of homes.splice(0)) {
    // A read-only fixture dir must be writable again before it can be removed.
    spawnSync("chmod", ["-R", "u+w", h]);
    rmSync(h, { recursive: true, force: true });
  }
});

type Env = Record<string, string>;

interface V08 {
  home: string;
  env: Env;
  cfgOld: string;
  dataOld: string;
  stateOld: string;
  cfgNew: string;
  dataNew: string;
  stateNew: string;
  rosterText: string;
  devEntry: unknown;
}

const WATCH_ENV = "# telemetry for the watch daemon\nSUITE_TELEMETRY_AUTH=Basic eA==\nOTHER_KEY=kept as is\n";

/** A v0.8.0 host: config, data and state under `suite`, a foreign config entry, a dev-checkout roster entry. */
function v08Home(): V08 {
  const home = mkdtempSync(join(tmpdir(), "burrow-migrate-"));
  homes.push(home);
  const cfgOld = join(home, ".config", "suite");
  const dataOld = join(home, ".local", "share", "suite");
  const stateOld = join(home, ".local", "state", "suite");
  mkdirSync(join(cfgOld, "agents"), { recursive: true });
  writeFileSync(join(cfgOld, "config.json"), '{"version":1}\n');
  writeFileSync(join(cfgOld, "state.json"), '{"seen":true}\n');
  writeFileSync(join(cfgOld, "watch.env"), WATCH_ENV, { mode: 0o600 });
  chmodSync(join(cfgOld, "watch.env"), 0o600);
  writeFileSync(join(cfgOld, "agents", "agent1-0000000000000000.json"), '{"runtimeId":"rt-1"}\n');
  writeFileSync(join(cfgOld, "agents", "agent1-0000000000000000.credentials.json"), '{"token":"t"}\n', { mode: 0o600 });
  mkdirSync(join(cfgOld, "dalton-usage-hook"));
  writeFileSync(join(cfgOld, "dalton-usage-hook", "run.sh"), "#!/bin/sh\n");

  mkdirSync(join(dataOld, "cli", "src"), { recursive: true });
  writeFileSync(join(dataOld, "cli", "src", "cli.ts"), "// 0.8 library\n");
  mkdirSync(join(dataOld, "claude-code-suite-channel", "src"), { recursive: true });
  writeFileSync(join(dataOld, "claude-code-suite-channel", "src", "index.ts"), "// channel\n");
  mkdirSync(join(dataOld, "deepseek", "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dataOld, "deepseek", "node_modules", ".bin", "dsh"), "#!/bin/sh\n");

  const managed = {
    session: "suite-agent1-abcd",
    command: [
      "tmux", "new-session", "-d", "-s", "suite-agent1-abcd", "-c", join(home, "agent1"),
      "/usr/bin/bun", join(dataOld, "cli", "src", "cli.ts"), "deepseek",
      "--plugin", join(dataOld, "claude-code-suite-channel", "src", "index.ts"),
      `--log=${join(stateOld, "sessions", "x.log")}`,
    ],
    cwd: join(dataOld, "deepseek"),
    kind: "deepseek",
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  const devEntry = {
    session: "suite-oddjob",
    command: [
      "tmux", "new-session", "-d", "-s", "suite-oddjob", "-c", join(home, "oddjob"),
      "/usr/bin/bun", join(home, "sources", "suite-cli", "src", "cli.ts"), "deepseek",
      "--harness", join(dataOld, "deepseek"),
    ],
    cwd: join(home, "oddjob"),
    kind: "deepseek",
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  const rosterText = `${JSON.stringify({ version: 1, agents: [managed, devEntry] }, null, 2)}\n`;
  mkdirSync(join(stateOld, "sessions"), { recursive: true });
  writeFileSync(join(stateOld, "agents.json"), rosterText);
  writeFileSync(join(stateOld, "sessions", "x.log"), "a line\n");
  return {
    home,
    env: { HOME: home },
    cfgOld,
    dataOld,
    stateOld,
    cfgNew: join(home, ".config", "burrow"),
    dataNew: join(home, ".local", "share", "burrow"),
    stateNew: join(home, ".local", "state", "burrow"),
    rosterText,
    devEntry,
  };
}

const EMPTY: ProcessSnapshot = { args: [], cwds: [] };

interface TestDeps extends MigrateDeps {
  errs: string[];
  probeCalls: number;
}

function deps(env: Env, over: Partial<MigrateDeps> & { snapshot?: ProcessSnapshot | null } = {}): TestDeps {
  const d: TestDeps = {
    env,
    fs: over.fs ?? liveMigrateFs(),
    probe: () => EMPTY,
    // Stage 2's rewrites: no claude, systemctl or tmux here (an empty HOME has
    // nothing for them to rewrite; test/migrate_rewrites.test.ts covers them).
    platform: "linux",
    uid: 1000,
    run: () => null,
    cgroupOf: () => null,
    pid: process.pid,
    pidAlive: () => false,
    now: () => new Date("2026-10-18T03:00:00.000Z"),
    stderr: (line) => void d.errs.push(line),
    sleep: () => {},
    lockWaitMs: 300,
    errs: [],
    probeCalls: 0,
    ...over,
  };
  const inner: LiveProbe = over.probe ?? (() => (over.snapshot === undefined ? EMPTY : over.snapshot));
  d.probe = () => {
    d.probeCalls++;
    return inner();
  };
  return d;
}

function readState(env: Env): MigrationState {
  const st = parseMigrationState(readFileSync(migrationStatePath(env), "utf8"));
  if (st === null) throw new Error("no state file");
  return st;
}

/** Every path under `dir` with its mode, size and content hash: a tree fingerprint, readable in a diff. */
function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (p: string) => {
    const s = lstatSync(p);
    const content = s.isFile() ? ` ${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}` : "";
    lines.push(`${p.slice(dir.length) || "/"} ${(s.mode & 0o7777).toString(8)} ${s.isDirectory() ? "dir" : s.size}${content}`);
    if (s.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(dir);
  return lines.join("\n");
}

/** An fs that records every call. */
function countingFs(base: MigrateFs = liveMigrateFs()): MigrateFs & { calls: string[] } {
  const calls: string[] = [];
  const out = { calls } as MigrateFs & { calls: string[] };
  for (const k of Object.keys(base) as (keyof MigrateFs)[]) {
    (out as any)[k] = (...a: unknown[]) => {
      calls.push(`${k} ${String(a[0])}`);
      return (base[k] as (...x: unknown[]) => unknown)(...a);
    };
  }
  return out;
}

/* ------------------------------------------------------------------------- */

describe("a cold v0.8.0 layout moves fully", () => {
  test("config, data and state entries land under burrow, checkouts renamed, old copies gone", () => {
    const h = v08Home();
    const d = deps(h.env);
    const r = migrateLegacyState(d);
    expect(r.outcome).toBe("ran");

    for (const f of ["config.json", "state.json", "watch.env", "agents/agent1-0000000000000000.json", "agents/agent1-0000000000000000.credentials.json"]) {
      expect(existsSync(join(h.cfgNew, f))).toBe(true);
      expect(existsSync(join(h.cfgOld, f))).toBe(false);
    }
    // Checkout children renamed through the map.
    expect(readFileSync(join(h.dataNew, "burrow-channel-claude-code", "src", "index.ts"), "utf8")).toBe("// channel\n");
    expect(existsSync(join(h.dataOld, "claude-code-suite-channel"))).toBe(false);
    expect(existsSync(join(h.dataNew, "deepseek", "node_modules", ".bin", "dsh"))).toBe(true);
    // The old library is retired, never moved: a watch daemon may run from it.
    expect(readFileSync(join(h.dataOld, "cli", "src", "cli.ts"), "utf8")).toBe("// 0.8 library\n");
    expect(existsSync(join(h.dataNew, "cli"))).toBe(false);
    // State.
    expect(existsSync(join(h.stateNew, "agents.json"))).toBe(true);
    expect(readFileSync(join(h.stateNew, "sessions", "x.log"), "utf8")).toBe("a line\n");

    const st = readState(h.env);
    expect(st.completedAt).toBe("2026-10-18T03:00:00.000Z");
    expect(st.refused).toEqual([]);
    expect(st.copiedLive).toEqual([]);
    expect(st.moved.map((e) => e.to).sort()).toEqual(
      [
        join(h.cfgNew, "agents"),
        join(h.cfgNew, "config.json"),
        join(h.cfgNew, "state.json"),
        join(h.cfgNew, "watch.env"),
        join(h.dataNew, "burrow-channel-claude-code"),
        join(h.dataNew, "deepseek"),
        join(h.stateNew, "agents.json"),
        join(h.stateNew, "sessions"),
      ].sort(),
    );
    // Old directories are never deleted; each holds a breadcrumb.
    for (const old of [h.cfgOld, h.dataOld, h.stateOld]) expect(existsSync(join(old, BREADCRUMB_FILENAME))).toBe(true);
    // stderr only, one summary line.
    expect(d.errs.length).toBe(1);
    expect(d.errs[0]).toContain("8 moved");
  });

  test("the roster's recorded paths are rewritten, checkouts through the map", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    const roster = JSON.parse(readFileSync(join(h.stateNew, "agents.json"), "utf8"));
    const managed = roster.agents[0];
    expect(managed.command).toContain(join(h.dataNew, "cli", "src", "cli.ts"));
    expect(managed.command).toContain(join(h.dataNew, "burrow-channel-claude-code", "src", "index.ts"));
    expect(managed.command).toContain(`--log=${join(h.stateNew, "sessions", "x.log")}`);
    expect(managed.cwd).toBe(join(h.dataNew, "deepseek"));
    expect(JSON.stringify(managed)).not.toContain("/suite/");
    // Everything else about the entry is unchanged.
    expect(managed.session).toBe("suite-agent1-abcd");
    expect(managed.recordedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a dev-checkout roster entry (a cli.ts outside the managed lib dir) stays byte-identical", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    const roster = JSON.parse(readFileSync(join(h.stateNew, "agents.json"), "utf8"));
    expect(JSON.stringify(roster.agents[1])).toBe(JSON.stringify(h.devEntry));
    // Positive control: the same entry run from the managed lib IS rewritten.
    const managedCli = JSON.parse(JSON.stringify(h.devEntry));
    managedCli.command[8] = join(h.dataOld, "cli", "src", "cli.ts");
    const text = `${JSON.stringify({ version: 1, agents: [managedCli] }, null, 2)}\n`;
    const out = rewriteRosterText(text, h.env);
    expect(out).not.toBeNull();
    expect(out).toContain(join(h.dataNew, "deepseek"));
  });

  test("watch.env has the BURROW key at 0600, and every other line is byte-identical", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    const path = join(h.cfgNew, "watch.env");
    expect(readFileSync(path, "utf8")).toBe(WATCH_ENV.replace("SUITE_TELEMETRY_AUTH=", "BURROW_TELEMETRY_AUTH="));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(envFilePath(h.home, h.env)).toBe(path);
  });

  test("after it, every path resolves under burrow", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    expect(configPath(h.env)).toBe(join(h.cfgNew, "config.json"));
    expect(defaultCheckout(h.env)).toBe(join(h.dataNew, PLUGIN_DIRNAME));
    expect(dataEntry("deepseek", h.env)).toBe(join(h.dataNew, "deepseek"));
    expect(rosterPath(h.home, h.env)).toBe(join(h.stateNew, "agents.json"));
    expect(stateEntry("sessions", h.env)).toBe(join(h.stateNew, "sessions"));
  });

  test("the checkout map and the config allowlist are pinned raw", () => {
    expect(CHECKOUT_DIR_MAP).toEqual({
      "claude-code-suite-channel": "burrow-channel-claude-code",
      "openclaw-suite-channel": "burrow-channel-openclaw",
      "hermes-suite-channel": "burrow-channel-hermes",
    });
    expect([...CONFIG_ALLOWLIST]).toEqual(["config.json", "state.json", "watch.env", "agents", "credentials.json"]);
  });
});

describe("idempotence: a completed migration reads its state file and nothing else", () => {
  test("a second run makes exactly one fs call (the state read) and never probes", () => {
    const h = v08Home();
    const first = countingFs();
    migrateLegacyState(deps(h.env, { fs: first }));
    // Positive control: the first run did real work.
    expect(first.calls.length).toBeGreaterThan(10);

    const before = readFileSync(migrationStatePath(h.env), "utf8");
    const second = countingFs();
    const d = deps(h.env, { fs: second });
    const r = migrateLegacyState(d);
    expect(r.outcome).toBe("done-already");
    expect(second.calls).toEqual([`readText ${migrationStatePath(h.env)}`]);
    expect(d.probeCalls).toBe(0);
    expect(d.errs).toEqual([]);
    expect(readFileSync(migrationStatePath(h.env), "utf8")).toBe(before);
  });

  test("an old dir a dev launcher keeps writing to is never re-scanned once done", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    writeFileSync(join(h.cfgOld, "config.json"), '{"written":"by an older dev checkout"}\n');
    migrateLegacyState(deps(h.env));
    expect(readFileSync(join(h.cfgOld, "config.json"), "utf8")).toContain("older dev checkout");
    expect(readFileSync(join(h.cfgNew, "config.json"), "utf8")).toBe('{"version":1}\n');
  });
});

describe("a live-referenced entry is copied, never moved", () => {
  test("argv naming the checkout: copied, original byte-identical, recorded as copiedLive", () => {
    const h = v08Home();
    const checkout = join(h.dataOld, "claude-code-suite-channel");
    const before = treeHash(checkout);
    const snapshot = { args: [`bun ${checkout}/src/index.ts`], cwds: [] };
    migrateLegacyState(deps(h.env, { snapshot }));
    expect(treeHash(checkout)).toBe(before);
    expect(readFileSync(join(h.dataNew, "burrow-channel-claude-code", "src", "index.ts"), "utf8")).toBe("// channel\n");
    const st = readState(h.env);
    expect(st.copiedLive.map((e) => e.from)).toEqual([checkout]);
    expect(st.moved.map((e) => e.from)).not.toContain(checkout);
    expect(existsSync(join(h.dataNew, "burrow-channel-claude-code.incoming"))).toBe(false);
  });

  test("a process whose cwd is inside an entry keeps it too", () => {
    const h = v08Home();
    const ds = join(h.dataOld, "deepseek");
    migrateLegacyState(deps(h.env, { snapshot: { args: [], cwds: [join(ds, "node_modules")] } }));
    expect(existsSync(join(ds, "node_modules", ".bin", "dsh"))).toBe(true);
    expect(readState(h.env).copiedLive.map((e) => e.from)).toEqual([ds]);
  });

  test("positive control: the same entry with no live reference is moved", () => {
    const h = v08Home();
    const checkout = join(h.dataOld, "claude-code-suite-channel");
    migrateLegacyState(deps(h.env, { snapshot: { args: ["bun /elsewhere/src/index.ts"], cwds: ["/elsewhere"] } }));
    expect(existsSync(checkout)).toBe(false);
    expect(readState(h.env).moved.map((e) => e.from)).toContain(checkout);
  });

  test("an unreadable process table counts every entry as live", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env, { snapshot: null }));
    const st = readState(h.env);
    expect(st.moved).toEqual([]);
    expect(st.copiedLive.length).toBe(8);
    expect(existsSync(join(h.cfgOld, "config.json"))).toBe(true);
  });

  test("the argv match is bounded: deepseek does not match deepseek-old", () => {
    const p = "/h/.local/share/suite/deepseek";
    expect(isLive(p, { args: ["node /h/.local/share/suite/deepseek-old/x"], cwds: [] })).toBe(false);
    expect(isLive(p, { args: ["node /h/.local/share/suite/deepseek/node_modules/.bin/dsh"], cwds: [] })).toBe(true);
    expect(isLive(p, { args: [`sh -c x ${p}`], cwds: [] })).toBe(true);
    expect(isLive(p, { args: [], cwds: ["/h/.local/share/suite/deepseek-old"] })).toBe(false);
    expect(isLive(p, null)).toBe(true);
  });
});

describe("foreign config entries stay put", () => {
  test("an entry this CLI never wrote is left, and listed in the breadcrumb", () => {
    const h = v08Home();
    const hook = join(h.cfgOld, "dalton-usage-hook");
    const before = treeHash(hook);
    migrateLegacyState(deps(h.env));
    expect(treeHash(hook)).toBe(before);
    expect(existsSync(join(h.cfgNew, "dalton-usage-hook"))).toBe(false);
    expect(readState(h.env).foreignLeft.map((e) => e.from)).toEqual([hook]);
    const crumb = readFileSync(join(h.cfgOld, BREADCRUMB_FILENAME), "utf8");
    expect(crumb).toContain("left in place, not written by this CLI");
    expect(crumb).toContain(hook);
    expect(crumb).toContain(`${join(h.cfgOld, "config.json")} -> ${join(h.cfgNew, "config.json")}`);
  });
});

/** An fs where nothing under `dir` can be renamed away or written into: the shape of `chmod -R a-w`. */
function readOnlyUnder(dir: string, base: MigrateFs = liveMigrateFs()): MigrateFs {
  const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const inside = (p: string) => p === dir || p.startsWith(`${dir}/`);
  return {
    ...base,
    rename(from, to) {
      if (inside(from) || inside(to)) throw eacces();
      base.rename(from, to);
    },
    remove(p) {
      if (inside(p)) throw eacces();
      base.remove(p);
    },
    writeAtomic(p, text, mode) {
      if (inside(p)) throw eacces();
      base.writeAtomic(p, text, mode);
    },
  };
}

describe("a read-only old dir is refused, and the launch continues", () => {
  test("refused entries: breadcrumb beside the dir, state lists them, the old path is still resolved for those only", () => {
    const h = v08Home();
    const d = deps(h.env, { fs: readOnlyUnder(h.cfgOld) });
    const r = migrateLegacyState(d);
    expect(r.outcome).toBe("ran");

    const st = readState(h.env);
    expect(st.refused.map((e) => e.from).sort()).toEqual(
      ["agents", "config.json", "state.json", "watch.env"].map((n) => join(h.cfgOld, n)).sort(),
    );
    expect(st.refused.every((e) => e.reason === "EACCES")).toBe(true);
    // The breadcrumb could not go inside, so it sits beside the dir.
    expect(existsSync(join(h.cfgOld, BREADCRUMB_FILENAME))).toBe(false);
    const beside = `${h.cfgOld}${BESIDE_BREADCRUMB_SUFFIX}`;
    expect(readFileSync(beside, "utf8")).toContain(join(h.cfgOld, "config.json"));
    // Nothing half-written on the burrow side.
    expect(existsSync(join(h.cfgNew, "config.json"))).toBe(false);
    expect(readdirSync(h.cfgNew).filter((n) => n.endsWith(".incoming"))).toEqual([]);
    // Resolution keeps the old location for the refused entries ONLY.
    expect(configPath(h.env)).toBe(join(h.cfgOld, "config.json"));
    expect(entryPath("config", "agents", h.env)).toBe(join(h.cfgOld, "agents"));
    expect(dataEntry("deepseek", h.env)).toBe(join(h.dataNew, "deepseek"));
    // stderr names each refused entry.
    for (const e of st.refused) expect(d.errs.some((l) => l.includes(e.from))).toBe(true);
    // Data and state were not held back by it.
    expect(existsSync(join(h.stateNew, "agents.json"))).toBe(true);
  });

  test("a later run with write access moves the refused entries, then is a no-op", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env, { fs: readOnlyUnder(h.cfgOld) }));
    expect(readState(h.env).refused.length).toBe(4);

    const second = deps(h.env);
    expect(migrateLegacyState(second).outcome).toBe("ran");
    const st = readState(h.env);
    expect(st.refused).toEqual([]);
    expect(existsSync(join(h.cfgNew, "config.json"))).toBe(true);
    expect(readFileSync(join(h.cfgNew, "watch.env"), "utf8")).toContain("BURROW_TELEMETRY_AUTH=");
    expect(configPath(h.env)).toBe(join(h.cfgNew, "config.json"));

    const third = countingFs();
    expect(migrateLegacyState(deps(h.env, { fs: third })).outcome).toBe("done-already");
    expect(third.calls.length).toBe(1);
  });

  test("a retry looks only at refused entries, never re-scans", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env, { fs: readOnlyUnder(h.cfgOld) }));
    // Written to an old root after the first run: not refused, so never looked at.
    writeFileSync(join(h.stateOld, "late.json"), "{}\n");
    migrateLegacyState(deps(h.env));
    expect(existsSync(join(h.stateOld, "late.json"))).toBe(true);
    expect(existsSync(join(h.stateNew, "late.json"))).toBe(false);
  });
});

describe("across filesystems", () => {
  test("EXDEV: copied to <target>.incoming, renamed into place, source removed", () => {
    const h = v08Home();
    const base = liveMigrateFs();
    const seen: string[] = [];
    const fs: MigrateFs = {
      ...base,
      rename(from, to) {
        seen.push(`${from} -> ${to}`);
        if (from.startsWith(`${h.dataOld}/`)) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        base.rename(from, to);
      },
    };
    migrateLegacyState(deps(h.env, { fs }));
    const target = join(h.dataNew, "deepseek");
    expect(seen).toContain(`${target}.incoming -> ${target}`);
    expect(existsSync(join(target, "node_modules", ".bin", "dsh"))).toBe(true);
    expect(existsSync(join(h.dataOld, "deepseek"))).toBe(false);
    expect(readState(h.env).moved.find((e) => e.to === target)?.reason).toBe("copy across filesystems");
  });

  test("EXDEV with a failing copy: refused, no .incoming left, source untouched", () => {
    const h = v08Home();
    const base = liveMigrateFs();
    const fs: MigrateFs = {
      ...base,
      rename(from, to) {
        if (from.startsWith(`${h.dataOld}/`)) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        base.rename(from, to);
      },
      copyTree(from, to) {
        base.copyTree(from, to);
        if (from.includes("deepseek")) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
    };
    const ds = join(h.dataOld, "deepseek");
    const before = treeHash(ds);
    migrateLegacyState(deps(h.env, { fs }));
    expect(treeHash(ds)).toBe(before);
    expect(existsSync(join(h.dataNew, "deepseek.incoming"))).toBe(false);
    expect(existsSync(join(h.dataNew, "deepseek"))).toBe(false);
    expect(readState(h.env).refused.find((e) => e.from === ds)?.reason).toBe("ENOSPC");
  });
});

describe("a target that already exists is skipped; a config dir that exists on both sides is merged", () => {
  test("burrow/<entry> present: the old one is left and skipped", () => {
    const h = v08Home();
    mkdirSync(join(h.dataNew, "deepseek"), { recursive: true });
    writeFileSync(join(h.dataNew, "deepseek", "mine"), "new\n");
    migrateLegacyState(deps(h.env));
    expect(existsSync(join(h.dataOld, "deepseek"))).toBe(true);
    expect(readdirSync(join(h.dataNew, "deepseek"))).toEqual(["mine"]);
    expect(readState(h.env).skipped.map((e) => e.from)).toContain(join(h.dataOld, "deepseek"));
  });

  test("agents/ on both sides: records burrow lacks are moved in one by one, burrow's own win", () => {
    const h = v08Home();
    mkdirSync(join(h.cfgNew, "agents"), { recursive: true });
    writeFileSync(join(h.cfgNew, "agents", "agent1-0000000000000000.json"), '{"runtimeId":"rt-burrow"}\n');
    migrateLegacyState(deps(h.env));
    expect(readFileSync(join(h.cfgNew, "agents", "agent1-0000000000000000.json"), "utf8")).toContain("rt-burrow");
    expect(existsSync(join(h.cfgNew, "agents", "agent1-0000000000000000.credentials.json"))).toBe(true);
    expect(existsSync(join(h.cfgOld, "agents", "agent1-0000000000000000.credentials.json"))).toBe(false);
  });
});

describe("the lock", () => {
  test("a live holder: the second process waits, then carries on without migrating, touching nothing", () => {
    const h = v08Home();
    mkdirSync(join(h.stateNew, "migration.lock"), { recursive: true });
    writeFileSync(join(h.stateNew, "migration.lock", "pid"), "424242\n");
    const slept: number[] = [];
    const d = deps(h.env, { pidAlive: (p) => p === 424242, sleep: (ms) => void slept.push(ms) });
    const r = migrateLegacyState(d);
    expect(r.outcome).toBe("lock-busy");
    expect(slept.length).toBeGreaterThan(0);
    expect(existsSync(join(h.cfgOld, "config.json"))).toBe(true);
    expect(existsSync(migrationStatePath(h.env))).toBe(false);
    // The holder's lock is still its own.
    expect(readFileSync(join(h.stateNew, "migration.lock", "pid"), "utf8")).toBe("424242\n");
  });

  test("a live holder that finishes while we wait: we see its state and do nothing", () => {
    const h = v08Home();
    mkdirSync(join(h.stateNew, "migration.lock"), { recursive: true });
    writeFileSync(join(h.stateNew, "migration.lock", "pid"), "424242\n");
    let alive = true;
    const d = deps(h.env, {
      pidAlive: () => alive,
      sleep: () => {
        // The holder completes: it migrates and releases.
        rmSync(join(h.stateNew, "migration.lock"), { recursive: true });
        migrateLegacyState(deps(h.env));
        alive = false;
      },
    });
    expect(migrateLegacyState(d).outcome).toBe("done-already");
  });

  test("a dead holder's lock is taken over", () => {
    const h = v08Home();
    mkdirSync(join(h.stateNew, "migration.lock"), { recursive: true });
    writeFileSync(join(h.stateNew, "migration.lock", "pid"), "999999\n");
    const r = migrateLegacyState(deps(h.env, { pidAlive: () => false }));
    expect(r.outcome).toBe("ran");
    expect(existsSync(join(h.stateNew, "migration.lock"))).toBe(false);
    expect(readState(h.env).refused).toEqual([]);
  });

  test("two real processes at once: each entry is moved exactly once and neither fails", async () => {
    const h = v08Home();
    const script = join(h.home, "race.ts");
    writeFileSync(
      script,
      `import { liveMigrateDeps, migrateLegacyState } from ${JSON.stringify(join(ROOT, "src", "migrate.ts"))};\n` +
        `const d = liveMigrateDeps({ HOME: ${JSON.stringify(h.home)} });\n` +
        `d.probe = () => ({ args: [], cwds: [] });\n` +
        `const r = migrateLegacyState(d);\n` +
        `console.log(r.outcome);\n`,
    );
    const runOne = () =>
      new Promise<{ code: number | null; out: string }>((done) => {
        const c = spawn(process.execPath, [script], { env: { ...process.env, HOME: h.home }, stdio: ["ignore", "pipe", "pipe"] });
        children.push(c);
        let out = "";
        c.stdout?.on("data", (b) => (out += b));
        c.on("exit", (code) => done({ code, out }));
      });
    const [a, b] = await Promise.all([runOne(), runOne()]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect([a.out.trim(), b.out.trim()].sort()).toEqual(["done-already", "ran"]);
    const st = readState(h.env);
    const tos = st.moved.map((e) => e.to);
    expect(new Set(tos).size).toBe(tos.length);
    expect(st.moved.length).toBe(8);
  });
});

describe("the process probe", () => {
  function io(over: Partial<ProbeIo>): ProbeIo {
    return {
      platform: "linux",
      run: (argv) => (argv[0] === "ps" ? { exitCode: 0, stdout: "bun /x/cli.ts watch\n" } : null),
      procCwds: () => ["/home/u"],
      ...over,
    };
  }

  test("linux: argv from ps, cwds from /proc", () => {
    expect(liveProbe(io({}))()).toEqual({ args: ["bun /x/cli.ts watch"], cwds: ["/home/u"] });
  });

  test("linux: /proc unreadable is unknown (null), never empty", () => {
    expect(liveProbe(io({ procCwds: () => null }))()).toBeNull();
  });

  test("ps failing is unknown", () => {
    expect(liveProbe(io({ run: () => ({ exitCode: 1, stdout: "" }) }))()).toBeNull();
    expect(liveProbe(io({ run: () => null }))()).toBeNull();
  });

  test("darwin: cwds come from lsof -a -d cwd -Fn, and /proc is never read", () => {
    const calls: string[][] = [];
    let procRead = false;
    const probe = liveProbe(
      io({
        platform: "darwin",
        run: (argv) => {
          calls.push(argv);
          if (argv[0] === "ps") return { exitCode: 0, stdout: "zsh\n" };
          return { exitCode: 0, stdout: "p123\nfcwd\nn/Users/u/.local/share/suite/deepseek\np124\nfcwd\nn/Users/u\n" };
        },
        procCwds: () => {
          procRead = true;
          return [];
        },
      }),
    );
    const snap = probe();
    expect(snap?.cwds).toEqual(["/Users/u/.local/share/suite/deepseek", "/Users/u"]);
    expect(calls).toContainEqual(["lsof", "-a", "-d", "cwd", "-Fn"]);
    expect(procRead).toBe(false);
    expect(isLive("/Users/u/.local/share/suite/deepseek", snap)).toBe(true);
    expect(parseLsofNames("p1\nfcwd\nn/a b\n")).toEqual(["/a b"]);
  });

  /** A darwin probe whose lsof is missing (null) or fails (exit 1). */
  function darwinProbe(lsof: { exitCode: number; stdout: string } | null): LiveProbe {
    return liveProbe(
      io({
        platform: "darwin",
        run: (argv) => (argv[0] === "ps" ? { exitCode: 0, stdout: "zsh\n" } : lsof),
      }),
    );
  }

  test("darwin: lsof missing or failing makes every entry LIVE, so the migration copies instead of moving", () => {
    for (const lsof of [null, { exitCode: 1, stdout: "" }]) {
      const h = v08Home();
      const ds = join(h.dataOld, "deepseek");
      const before = treeHash(ds);
      migrateLegacyState(deps(h.env, { probe: darwinProbe(lsof) }));
      expect(treeHash(ds)).toBe(before);
      const st = readState(h.env);
      expect(st.moved).toEqual([]);
      expect(st.copiedLive.map((e) => e.from)).toContain(ds);
    }
  });

  test("darwin positive control: a working lsof with nothing under the entry lets it move", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env, { probe: darwinProbe({ exitCode: 0, stdout: "p1\nfcwd\nn/elsewhere\n" }) }));
    expect(existsSync(join(h.dataOld, "deepseek"))).toBe(false);
    expect(readState(h.env).copiedLive).toEqual([]);
  });

  test("an unknown platform has no cwd source, so it is unknown", () => {
    expect(liveProbe(io({ platform: "freebsd" }))()).toBeNull();
  });

  test("the real probe sees a real process by argv and by cwd", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "burrow-probe-"));
    homes.push(dir);
    const byArg = join(dir, "by-arg");
    const byCwd = join(dir, "by-cwd");
    mkdirSync(byArg);
    mkdirSync(byCwd);
    children.push(spawn("sh", ["-c", "sleep 30", join(byArg, "marker")], { stdio: "ignore" }));
    children.push(spawn("sleep", ["30"], { cwd: byCwd, stdio: "ignore" }));
    await Bun.sleep(200);
    const snap = liveProbe()();
    expect(snap).not.toBeNull();
    expect(isLive(byArg, snap)).toBe(true);
    expect(isLive(byCwd, snap)).toBe(true);
    // Negative control: a path no process uses.
    expect(isLive(join(dir, "unused"), snap)).toBe(false);
  });
});

describe("rewrites", () => {
  test("watch.env: only the key changes; an existing BURROW key means nothing changes", () => {
    expect(rewriteWatchEnv("A=1\nSUITE_TELEMETRY_AUTH=x\nB=2")).toBe("A=1\nBURROW_TELEMETRY_AUTH=x\nB=2");
    expect(rewriteWatchEnv("export SUITE_TELEMETRY_AUTH='Basic eA=='\n")).toBe("export BURROW_TELEMETRY_AUTH='Basic eA=='\n");
    expect(rewriteWatchEnv("BURROW_TELEMETRY_AUTH=y\nSUITE_TELEMETRY_AUTH=x\n")).toBeNull();
    expect(rewriteWatchEnv("A=1\n")).toBeNull();
  });

  test("a roster that is not a roster is left alone", () => {
    expect(rewriteRosterText("not json", { HOME: "/h" })).toBeNull();
    expect(rewriteRosterText('{"agents":[]}', { HOME: "/h" })).toBeNull();
  });
});

describe("the CLI runs the migration for every verb except the machine-read ones", () => {
  test("shouldMigrate", () => {
    for (const argv of [[], ["--version"], ["-V"], ["--help"], ["-h"], ["update"], ["pane-status"], ["nope"],
      ["hermes", "--stamp-only"], ["openclaw", "--root", "/r", "--stamp-only"]]) {
      expect(shouldMigrate(argv)).toBe(false);
    }
    for (const argv of [["status"], ["status", "--json"], ["claude"], ["doctor"], ["watch"], ["restore"], ["init"],
      ["hermes"], ["openclaw"], ["deepseek"], ["codex"], ["hermes", "--", "--stamp-only"]]) {
      expect(shouldMigrate(argv)).toBe(true);
    }
  });

  function snapshotTree(home: string): string {
    return treeHash(home);
  }

  test("--version and --help: stdout byte-identical to 0.8, and the fs untouched", () => {
    const h = v08Home();
    const before = snapshotTree(h.home);
    // bun's own transpiler cache would otherwise land in $HOME/.bun: not ours, so off.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
    const v = spawnSync(process.execPath, [CLI, "--version"], { env, encoding: "utf8" });
    expect(v.stdout).toBe(`${VERSION}\n`);
    expect(v.stderr).toBe("");
    const help = spawnSync(process.execPath, [CLI, "--help"], { env, encoding: "utf8" });
    expect(help.stdout).toBe(`${usage()}\n`);
    expect(help.stderr).toBe("");
    expect(snapshotTree(h.home)).toBe(before);
  });

  test("positive control: `status --json` migrates, with migration lines on stderr only", () => {
    const h = v08Home();
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.home, TMUX_TMPDIR: h.home };
    const r = spawnSync(process.execPath, [CLI, "status", "--json"], { env, encoding: "utf8", cwd: h.home });
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout).not.toContain("moved state");
    expect(r.stderr).toContain("moved state to the burrow directories");
    expect(existsSync(migrationStatePath({ HOME: h.home }))).toBe(true);
    expect(existsSync(join(h.cfgNew, "config.json"))).toBe(true);
  });
});

describe("burrow doctor's leftovers", () => {
  test("lists every old root still on disk, and what uses it", () => {
    const h = v08Home();
    migrateLegacyState(deps(h.env));
    const ds = `node ${join(h.dataOld, "cli", "src", "cli.ts")} watch`;
    const list = legacyLeftovers(h.env, () => ({ args: [ds], cwds: [] }));
    expect(list.map((l) => l.path)).toEqual([h.cfgOld, h.dataOld, h.stateOld]);
    expect(list[1]?.users).toEqual([ds]);
    expect(list[0]?.users).toEqual([]);
    expect(legacyLeftovers(h.env, () => null)[0]?.users).toEqual(["(the process table could not be read)"]);
  });

  test("a host with no old roots lists nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "burrow-migrate-"));
    homes.push(home);
    expect(legacyLeftovers({ HOME: home }, () => EMPTY)).toEqual([]);
  });
});

describe("a host with nothing to migrate", () => {
  test("a cold HOME: the state file is written, nothing else, and no stderr", () => {
    const home = mkdtempSync(join(tmpdir(), "burrow-migrate-"));
    homes.push(home);
    const d = deps({ HOME: home });
    expect(migrateLegacyState(d).outcome).toBe("ran");
    expect(d.errs).toEqual([]);
    expect(readdirSync(join(home, ".local", "state", "burrow"))).toEqual(["migration.json"]);
    expect(migrateLegacyState(deps({ HOME: home })).outcome).toBe("done-already");
  });
});
