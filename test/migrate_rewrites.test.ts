/**
 * The second half of the one-shot migration (src/migrate.ts runRewrites): the
 * paths OTHER programs recorded for this CLI, and the watchdog/restore units.
 *
 * Every case runs against a throwaway mkdtemp HOME. `claude` is the real stub
 * at test/fixtures/stub_claude_local_scope.ts, which really writes
 * ~/.claude.json and logs every call to STUB_LOG; systemctl, launchctl, tmux
 * and openclaw are an in-memory model behind the injected runner. Nothing here
 * runs a real service manager or touches a real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_SUFFIX,
  BESIDE_BREADCRUMB_SUFFIX,
  RETIRED_SUFFIX,
  liveMigrateFs,
  migrateLegacyState,
  migrationStatePath,
  parseCgroupFile,
  parseMigrationState,
  unitInputFrom,
  type CommandResult,
  type MigrateDeps,
  type MigrationState,
} from "../src/migrate.ts";
import {
  KILL_MODE_LINE,
  LAUNCHD_LABEL,
  RESTORE_LAUNCHD_LABEL,
  RESTORE_SERVICE_NAME,
  SERVICE_NAME,
  ensureSupervision,
  installSupervisor,
  launchdPlist,
  restoreLaunchdPlist,
  restoreUnit,
  supervisorPlan,
  systemdUnit,
  type SupervisorIo,
} from "../src/supervisor.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUB = join(ROOT, "test", "fixtures", "stub_claude_local_scope.ts");

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

type Env = Record<string, string>;

interface Host {
  home: string;
  env: Env;
  dataOld: string;
  dataNew: string;
  oldIndex: string;
  newIndex: string;
  stubLog: string;
  units: string;
}

/** A v0.8.0 data dir holding the claude channel checkout (stage 1 moves it), plus two agent folders. */
function host(): Host {
  const home = mkdtempSync(join(tmpdir(), "burrow-rewrite-"));
  homes.push(home);
  const dataOld = join(home, ".local", "share", "suite");
  const dataNew = join(home, ".local", "share", "burrow");
  mkdirSync(join(dataOld, "claude-code-suite-channel", "src"), { recursive: true });
  writeFileSync(join(dataOld, "claude-code-suite-channel", "src", "index.ts"), "// channel\n");
  mkdirSync(join(home, "agent1"));
  mkdirSync(join(home, "agent2"));
  return {
    home,
    env: { HOME: home },
    dataOld,
    dataNew,
    oldIndex: join(dataOld, "claude-code-suite-channel", "src", "index.ts"),
    newIndex: join(dataNew, "burrow-channel-claude-code", "src", "index.ts"),
    stubLog: join(home, "stub.log"),
    units: join(home, ".config", "systemd", "user"),
  };
}

/** Run the stub claude as the real CLI would be run: cwd, HOME, STUB_LOG. */
function stubClaude(h: Host, args: string[], cwd: string, extra: Env = {}): CommandResult {
  const p = spawnSync(process.execPath, [STUB, ...args], {
    cwd,
    env: { HOME: h.home, STUB_LOG: h.stubLog, ...extra },
    encoding: "utf8",
  });
  return { exitCode: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

const CHANNEL_ENV = ["-e", "SUITE_URL=wss://x.example/socket", "-e", "SUITE_RUNTIME_ID=rt-1", "-e", "SUITE_TOKEN=tok-1"];

/** Two local-scope entries (agent1, agent2), one user-scope entry, all naming the 0.8 checkout. */
function seedClaudeJson(h: Host): void {
  for (const dir of [join(h.home, "agent1"), join(h.home, "agent2")]) {
    expect(stubClaude(h, ["mcp", "add", "suite-channel", "-s", "local", ...CHANNEL_ENV, "--", "bun", h.oldIndex], dir).exitCode).toBe(0);
    expect(stubClaude(h, ["mcp", "add", "startup-suite", "-s", "local", "-t", "http", "https://x.example/mcp", "-H", "Authorization: Bearer tok-1"], dir).exitCode).toBe(0);
  }
  expect(stubClaude(h, ["mcp", "add", "suite-channel", "-s", "user", ...CHANNEL_ENV, "--", "bun", h.oldIndex], h.home).exitCode).toBe(0);
  writeFileSync(h.stubLog, "");
}

function claudeJson(h: Host): any {
  return JSON.parse(readFileSync(join(h.home, ".claude.json"), "utf8"));
}

function stubCalls(h: Host): string[] {
  return existsSync(h.stubLog) ? readFileSync(h.stubLog, "utf8").split("\n").filter((l) => l !== "") : [];
}

/* ------------------------------------------------------------------------- */
/* The in-memory system: systemctl, launchctl, tmux, openclaw                 */
/* ------------------------------------------------------------------------- */

interface Unit {
  enabled: boolean;
  active: boolean;
  cgroup: string;
  invocation?: string;
}

interface World {
  calls: string[][];
  units: Map<string, Unit>;
  /** tmux server + pane pids on the default socket. */
  tmuxPids: number[];
  tmuxSessions: Set<string>;
  cgroups: Map<number | "self", string[]>;
  launchd: Set<string>;
  systemctl: boolean;
  /** Exit codes to force for an argv (joined with spaces), consumed once. */
  failOnce: Map<string, number>;
  /** argv of `claude mcp add-json` to fail once. */
  failAddJsonOnce: boolean;
  stubEnv: Env;
}

function world(over: Partial<World> = {}): World {
  return {
    calls: [],
    units: new Map(),
    tmuxPids: [],
    tmuxSessions: new Set(),
    cgroups: new Map(),
    launchd: new Set(),
    systemctl: true,
    failOnce: new Map(),
    failAddJsonOnce: false,
    stubEnv: {},
    ...over,
  };
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const no = (stderr = "", exitCode = 1): CommandResult => ({ exitCode, stdout: "", stderr });

function runner(h: Host, w: World): MigrateDeps["run"] {
  return (argv, opts = {}) => {
    w.calls.push(argv);
    const joined = argv.join(" ");
    const forced = w.failOnce.get(joined);
    if (forced !== undefined) {
      w.failOnce.delete(joined);
      return no("forced failure", forced);
    }
    const [cmd, ...a] = argv;
    if (cmd === "claude") {
      if (a[1] === "add-json" && w.failAddJsonOnce) {
        w.failAddJsonOnce = false;
        return no("forced add-json failure");
      }
      return stubClaude(h, a, opts.cwd ?? h.home, w.stubEnv);
    }
    if (cmd === "systemctl") {
      if (!w.systemctl) return null;
      const [, verb, ...rest] = a; // a[0] is --user
      const unit = (name: string | undefined) => w.units.get(name ?? "");
      switch (verb) {
        case "daemon-reload":
          return ok();
        case "is-enabled":
          return unit(rest[0]) === undefined ? no("not-found") : unit(rest[0])?.enabled ? ok("enabled\n") : no("disabled\n");
        case "is-active": {
          const u = unit(rest[0]);
          return u?.active ? ok("active\n") : { exitCode: 3, stdout: "inactive\n", stderr: "" };
        }
        case "show": {
          const prop = rest[1];
          const u = unit(rest[rest.length - 1]);
          if (prop === "ControlGroup") return ok(`${u?.active ? u.cgroup : ""}\n`);
          if (prop === "InvocationID") return ok(`${u?.invocation ?? ""}\n`);
          return ok("\n");
        }
        case "enable":
        case "disable":
        case "start":
        case "stop": {
          const name = rest[0] as string;
          const u = w.units.get(name) ?? { enabled: false, active: false, cgroup: `/user.slice/app.slice/${name}` };
          w.units.set(name, u);
          if (verb === "enable") u.enabled = true;
          if (verb === "disable") u.enabled = false;
          if (verb === "start") u.active = true;
          if (verb === "stop") u.active = false;
          return ok();
        }
      }
      return no(`unmodelled systemctl ${verb}`);
    }
    if (cmd === "tmux") {
      if (a[0] === "list-sessions" || a[0] === "list-panes") {
        return w.tmuxPids.length === 0 ? no("no server running") : ok(`${w.tmuxPids.join("\n")}\n`);
      }
      const target = (a[a.indexOf("-t") + 1] ?? "").replace(/^=/, "");
      if (a[0] === "has-session") return w.tmuxSessions.has(target) ? ok() : no("can't find session");
      if (a[0] === "kill-session") return w.tmuxSessions.delete(target) ? ok() : no("can't find session");
      if (a[0] === "new-session") {
        w.tmuxSessions.add(a[a.indexOf("-s") + 1] as string);
        return ok();
      }
      return no("unmodelled tmux");
    }
    if (cmd === "launchctl") {
      const label = (s: string | undefined) => (s ?? "").split("/").slice(2).join("/");
      if (a[0] === "print") return w.launchd.has(label(a[1])) ? ok("state = running\n") : no("Could not find service", 113);
      if (a[0] === "bootout") return w.launchd.delete(label(a[1])) ? ok() : no("No such process", 3);
      if (a[0] === "bootstrap") {
        const plist = a[2] as string;
        w.launchd.add(plist.slice(plist.lastIndexOf("/") + 1).replace(/\.plist$/, ""));
        return ok();
      }
      return no("unmodelled launchctl");
    }
    if (cmd !== undefined && (cmd === "openclaw" || cmd.endsWith("/.bin/openclaw"))) {
      if (w.failOnce.has("openclaw-missing")) return null;
      // `openclaw config set <key> <json> --strict-json`, against OPENCLAW_CONFIG_PATH.
      const file = opts.env?.OPENCLAW_CONFIG_PATH as string;
      const doc = JSON.parse(readFileSync(file, "utf8"));
      const keys = (a[2] as string).split(".");
      let node = doc;
      for (const k of keys.slice(0, -1)) node = node[k] ??= {};
      node[keys[keys.length - 1] as string] = JSON.parse(a[3] as string);
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      return ok();
    }
    return null;
  };
}

interface TestDeps extends MigrateDeps {
  errs: string[];
}

function deps(h: Host, w: World, over: Partial<MigrateDeps> = {}): TestDeps {
  const d: TestDeps = {
    env: h.env,
    fs: liveMigrateFs(),
    probe: () => ({ args: [], cwds: [] }),
    platform: "linux",
    uid: 501,
    run: runner(h, w),
    cgroupOf: (pid) => w.cgroups.get(pid) ?? null,
    pid: process.pid,
    pidAlive: () => false,
    now: () => new Date("2026-10-18T03:00:00.000Z"),
    stderr: (line) => void d.errs.push(line),
    sleep: () => {},
    lockWaitMs: 300,
    errs: [],
    ...over,
  };
  return d;
}

function readState(h: Host): MigrationState {
  const st = parseMigrationState(readFileSync(migrationStatePath(h.env), "utf8"));
  if (st === null) throw new Error("no state file");
  return st;
}

/** argv strings for one command, for order assertions. */
function callsOf(w: World, cmd: string): string[] {
  return w.calls.filter((c) => c[0] === cmd).map((c) => c.join(" "));
}

/* ------------------------------------------------------------------------- */
/* 1. ~/.claude.json                                                          */
/* ------------------------------------------------------------------------- */

describe("~/.claude.json channel entries are rewritten through the claude CLI", () => {
  test("two project blocks and the user-scope entry: new path, env and names unchanged, read back", () => {
    const h = host();
    seedClaudeJson(h);
    const before = claudeJson(h);
    const w = world();
    const r = migrateLegacyState(deps(h, w));
    expect(r.outcome).toBe("ran");

    const after = claudeJson(h);
    for (const dir of ["agent1", "agent2"]) {
      const local = after.projects[join(h.home, dir)].mcpServers;
      expect(local["suite-channel"].command).toBe("bun");
      expect(local["suite-channel"].args).toEqual([h.newIndex]);
      expect(local["suite-channel"].env).toEqual(before.projects[join(h.home, dir)].mcpServers["suite-channel"].env);
      // The tools entry names no data path and is untouched.
      expect(local["startup-suite"]).toEqual(before.projects[join(h.home, dir)].mcpServers["startup-suite"]);
    }
    expect(after.mcpServers["suite-channel"].args).toEqual([h.newIndex]);
    expect(after.mcpServers["suite-channel"].env).toEqual(before.mcpServers["suite-channel"].env);
    expect(existsSync(h.newIndex)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(h.dataOld);

    // Through the CLI: a remove and an add-json per entry, each in that entry's folder.
    const calls = stubCalls(h);
    expect(calls.filter((c) => c.startsWith("claude\tmcp\tremove\tsuite-channel")).length).toBe(3);
    expect(calls.filter((c) => c.startsWith("claude\tmcp\tadd-json\tsuite-channel")).length).toBe(3);
    const st = readState(h);
    expect(st.rewritten.filter((e) => e.step === "claude-mcp").map((e) => e.path).sort()).toEqual(
      [
        `${join(h.home, ".claude.json")}:${join(h.home, "agent1")}:suite-channel`,
        `${join(h.home, ".claude.json")}:${join(h.home, "agent2")}:suite-channel`,
        `${join(h.home, ".claude.json")}:user:suite-channel`,
      ].sort(),
    );
    expect(st.deferred).toEqual([]);
  });

  test("a second run makes zero claude calls (positive control: the first made some)", () => {
    const h = host();
    seedClaudeJson(h);
    migrateLegacyState(deps(h, world()));
    const first = stubCalls(h).length;
    expect(first).toBeGreaterThan(0);
    const before = readFileSync(migrationStatePath(h.env), "utf8");

    const w = world();
    expect(migrateLegacyState(deps(h, w)).outcome).toBe("done-already");
    expect(stubCalls(h).length).toBe(first);
    expect(w.calls).toEqual([]);
    expect(readFileSync(migrationStatePath(h.env), "utf8")).toBe(before);
  });

  test("a project folder that no longer exists is skipped, reported, and not retried", () => {
    const h = host();
    seedClaudeJson(h);
    const gone = join(h.home, "agent3");
    mkdirSync(gone);
    stubClaude(h, ["mcp", "add", "suite-channel", "-s", "local", ...CHANNEL_ENV, "--", "bun", h.oldIndex], gone);
    rmSync(gone, { recursive: true });
    writeFileSync(h.stubLog, "");

    migrateLegacyState(deps(h, world()));
    const st = readState(h);
    expect(st.rewriteSkipped).toEqual([
      expect.objectContaining({ step: "claude-mcp", path: `${join(h.home, ".claude.json")}:${gone}:suite-channel`, reason: "the project folder no longer exists" }),
    ]);
    expect(st.deferred).toEqual([]);
    // Left exactly as it was, and no claude call ran in it.
    expect(claudeJson(h).projects[gone].mcpServers["suite-channel"].args).toEqual([h.oldIndex]);
    expect(stubCalls(h).some((c) => c.includes(gone))).toBe(false);
    expect(st.rewritten.filter((e) => e.step === "claude-mcp").length).toBe(3);
  });

  test("a claude without add-json: falls back to `mcp add` built from the entry's own env", () => {
    const h = host();
    seedClaudeJson(h);
    const before = claudeJson(h);
    const w = world({ stubEnv: { STUB_NO_ADD_JSON: "1" } });
    migrateLegacyState(deps(h, w));
    const after = claudeJson(h);
    const local = after.projects[join(h.home, "agent1")].mcpServers["suite-channel"];
    expect(local.args).toEqual([h.newIndex]);
    expect(local.env).toEqual(before.projects[join(h.home, "agent1")].mcpServers["suite-channel"].env);
    const calls = stubCalls(h);
    expect(calls.some((c) => c.startsWith("claude\tmcp\tadd-json"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("claude\tmcp\tadd\tsuite-channel")).length).toBe(3);
    expect(readState(h).deferred).toEqual([]);
  });

  test("a failed add puts the original entry back and defers; a later run finishes it", () => {
    const h = host();
    seedClaudeJson(h);
    const w = world({ failAddJsonOnce: true });
    migrateLegacyState(deps(h, w));
    let st = readState(h);
    expect(st.deferred.length).toBe(1);
    expect(st.deferred[0]?.reason).toContain("the original entry was restored");
    // Whichever entry failed still names the old checkout, which still exists, so it still works.
    const all = claudeJson(h);
    const failed = [all.projects[join(h.home, "agent1")].mcpServers, all.projects[join(h.home, "agent2")].mcpServers, all.mcpServers]
      .map((m) => m["suite-channel"])
      .filter((e) => e.args[0] === h.oldIndex);
    expect(failed.length).toBe(1);

    migrateLegacyState(deps(h, world()));
    st = readState(h);
    expect(st.deferred).toEqual([]);
    expect(JSON.stringify(claudeJson(h))).not.toContain(h.dataOld);
  });

  test("the new checkout is not there (the move was refused): deferred, and nothing is removed", () => {
    const h = host();
    seedClaudeJson(h);
    // A burrow target that exists but lacks src/index.ts: the move is skipped and the path is missing.
    mkdirSync(join(h.dataNew, "burrow-channel-claude-code"), { recursive: true });
    migrateLegacyState(deps(h, world()));
    const st = readState(h);
    expect(st.deferred.filter((e) => e.step === "claude-mcp").length).toBe(3);
    expect(stubCalls(h).some((c) => c.includes("\tremove\t"))).toBe(false);
    expect(claudeJson(h).mcpServers["suite-channel"].args).toEqual([h.oldIndex]);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. agents' openclaw, dsh and hermes configs                                */
/* ------------------------------------------------------------------------- */

/** A roster with a managed openclaw agent, a managed deepseek agent, a hermes agent and a dev-checkout deepseek agent. */
function seedAgents(h: Host): { oc: string; ds: string; hm: string; odd: string; patch: string; oddPatch: string; hermesYaml: string } {
  const oc = join(h.home, "agents", "ocagent");
  const ds = join(h.home, "agents", "dsagent");
  const hm = join(h.home, "agents", "hmagent");
  const odd = join(h.home, "agents", "oddjob");
  mkdirSync(join(h.dataOld, "openclaw-suite-channel"), { recursive: true });
  mkdirSync(join(h.dataOld, "hermes-suite-channel", "bridge"), { recursive: true });
  mkdirSync(join(h.dataOld, "deepseek", "plugins", "suite-federation"), { recursive: true });
  writeFileSync(join(h.dataOld, "deepseek", "plugins", "suite-federation", "index.js"), "// plugin\n");
  mkdirSync(join(oc, ".openclaw"), { recursive: true });
  writeFileSync(
    join(oc, ".openclaw", "openclaw.json"),
    `${JSON.stringify({ gateway: { port: 18800 }, plugins: { load: { paths: [join(h.dataOld, "openclaw-suite-channel"), "/opt/other"] } } }, null, 2)}\n`,
  );
  const patchText = (d: string) => `plugins:\n  - path: ${join(d, "deepseek", "plugins", "suite-federation", "index.js")}\n    headers: [x-a]\n`;
  for (const root of [ds, odd]) {
    mkdirSync(join(root, ".dsh"), { recursive: true });
    writeFileSync(join(root, ".dsh", "suite.patch.yml"), patchText(h.dataOld));
  }
  mkdirSync(join(hm, ".hermes"), { recursive: true });
  writeFileSync(
    join(hm, ".hermes", "config.yaml"),
    `# operator comment, kept\nmodel:\n  provider: custom # inline, kept\nmcp_servers:\n  startup-suite:\n    command: python3\n    args:\n      - ${join(h.dataOld, "hermes-suite-channel", "bridge")}\n      - --stdio\n`,
  );
  const entry = (session: string, cwd: string, cli: string, verb: string) => ({
    session,
    command: ["tmux", "new-session", "-d", "-s", session, "-c", cwd, "/usr/bin/bun", cli, verb, "--root", cwd],
    cwd,
    kind: verb,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  const managedCli = join(h.dataOld, "cli", "src", "cli.ts");
  const roster = {
    version: 1,
    agents: [
      entry("suite-ocagent", oc, managedCli, "openclaw"),
      entry("suite-dsagent", ds, managedCli, "deepseek"),
      entry("suite-hmagent", hm, managedCli, "hermes"),
      entry("suite-oddjob", odd, join(h.home, "sources", "suite-cli", "src", "cli.ts"), "deepseek"),
    ],
  };
  mkdirSync(join(h.home, ".local", "state", "suite"), { recursive: true });
  writeFileSync(join(h.home, ".local", "state", "suite", "agents.json"), `${JSON.stringify(roster, null, 2)}\n`);
  mkdirSync(join(h.dataNew, "cli", "src"), { recursive: true }); // install.sh wrote it
  return {
    oc,
    ds,
    hm,
    odd,
    patch: join(ds, ".dsh", "suite.patch.yml"),
    oddPatch: join(odd, ".dsh", "suite.patch.yml"),
    hermesYaml: join(hm, ".hermes", "config.yaml"),
  };
}

describe("agents' configs that name the old data dir", () => {
  test("openclaw: plugins.load.paths is set through `openclaw config set`, in that agent's state dir", () => {
    const h = host();
    const a = seedAgents(h);
    const w = world();
    migrateLegacyState(deps(h, w));
    const doc = JSON.parse(readFileSync(join(a.oc, ".openclaw", "openclaw.json"), "utf8"));
    expect(doc.plugins.load.paths).toEqual([join(h.dataNew, "burrow-channel-openclaw"), "/opt/other"]);
    expect(doc.gateway.port).toBe(18800);
    const set = w.calls.find((c) => c[1] === "config" && c[2] === "set");
    expect(set?.slice(1)).toEqual(["config", "set", "plugins.load.paths", JSON.stringify(doc.plugins.load.paths), "--strict-json"]);
    // No hand-edit happened, so there is no backup.
    expect(readdirSync(join(a.oc, ".openclaw")).some((n) => n.includes(BACKUP_SUFFIX))).toBe(false);
    expect(readState(h).rewritten).toContainEqual(expect.objectContaining({ step: "openclaw", reason: "openclaw config set" }));
  });

  test("openclaw not installed: only that key is edited by hand, with a backup, and read back", () => {
    const h = host();
    const a = seedAgents(h);
    const file = join(a.oc, ".openclaw", "openclaw.json");
    const original = readFileSync(file, "utf8");
    const w = world();
    w.failOnce.set("openclaw-missing", 0);
    migrateLegacyState(deps(h, w));
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.plugins.load.paths).toEqual([join(h.dataNew, "burrow-channel-openclaw"), "/opt/other"]);
    expect(doc.gateway).toEqual({ port: 18800 });
    expect(readFileSync(`${file}${BACKUP_SUFFIX}20261018T030000Z`, "utf8")).toBe(original);
  });

  test("dsh: the harness path in the patch is edited by hand with a backup; the dev checkout's agent is left byte-identical", () => {
    const h = host();
    const a = seedAgents(h);
    const oddBefore = readFileSync(a.oddPatch, "utf8");
    const dsBefore = readFileSync(a.patch, "utf8");
    migrateLegacyState(deps(h, world()));
    expect(readFileSync(a.patch, "utf8")).toBe(dsBefore.replace(join(h.dataOld, "deepseek"), join(h.dataNew, "deepseek")));
    expect(readFileSync(`${a.patch}${BACKUP_SUFFIX}20261018T030000Z`, "utf8")).toBe(dsBefore);
    expect(readFileSync(a.oddPatch, "utf8")).toBe(oddBefore);
    expect(existsSync(`${a.oddPatch}${BACKUP_SUFFIX}20261018T030000Z`)).toBe(false);
    const st = readState(h);
    expect(st.rewriteSkipped).toContainEqual(expect.objectContaining({ step: "dsh", path: a.oddPatch }));
    expect(st.rewritten).toContainEqual(expect.objectContaining({ step: "dsh", path: a.patch }));
  });

  test("hermes: only the values naming the old dir change; comments and every other line are kept", () => {
    const h = host();
    const a = seedAgents(h);
    const before = readFileSync(a.hermesYaml, "utf8");
    migrateLegacyState(deps(h, world()));
    const after = readFileSync(a.hermesYaml, "utf8");
    expect(after).toBe(before.replace(join(h.dataOld, "hermes-suite-channel"), join(h.dataNew, "burrow-channel-hermes")));
    expect(readFileSync(`${a.hermesYaml}${BACKUP_SUFFIX}20261018T030000Z`, "utf8")).toBe(before);
    expect(readState(h).rewritten).toContainEqual(expect.objectContaining({ step: "hermes", path: `${a.hermesYaml}:mcp_servers.startup-suite.args.0` }));
  });

  test("the second run touches none of them", () => {
    const h = host();
    const a = seedAgents(h);
    migrateLegacyState(deps(h, world()));
    const snap = [a.patch, a.hermesYaml, join(a.oc, ".openclaw", "openclaw.json")].map((p) => [p, statSync(p).mtimeMs, readFileSync(p, "utf8")]);
    const w = world();
    expect(migrateLegacyState(deps(h, w)).outcome).toBe("done-already");
    expect(w.calls).toEqual([]);
    for (const [p, mtime, text] of snap) {
      expect(statSync(p as string).mtimeMs).toBe(mtime as number);
      expect(readFileSync(p as string, "utf8")).toBe(text as string);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 3. units and plists                                                        */
/* ------------------------------------------------------------------------- */

const OLD_WATCH = `[Unit]
Description=Suite agent session watchdog
After=default.target

[Service]
Type=simple
Environment=PATH=/opt/custom/bin:/usr/bin
Environment=HOME=/home/q
Environment=LANG=en_GB.UTF-8
EnvironmentFile=-/home/q/.config/suite/watch.env
ExecStart=/home/q/.local/bin/suite watch --interval 90
Restart=always

[Install]
WantedBy=default.target
`;

const OLD_AGENTS = `[Unit]
Description=Restore Suite agent sessions after boot

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/home/q/.local/bin/suite restore

[Install]
WantedBy=default.target
`;

function seedUnits(h: Host, w: World, watch: Partial<Unit> = {}, agents: Partial<Unit> = {}): void {
  mkdirSync(h.units, { recursive: true });
  writeFileSync(join(h.units, "suite-watch.service"), OLD_WATCH);
  writeFileSync(join(h.units, "suite-agents.service"), OLD_AGENTS);
  w.units.set("suite-watch.service", { enabled: true, active: true, cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/suite-watch.service", ...watch });
  w.units.set("suite-agents.service", { enabled: false, active: false, cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/suite-agents.service", ...agents });
}

function retiredFiles(dir: string, name: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(`${name}${RETIRED_SUFFIX}`));
}

describe("the unit text", () => {
  const input = { platform: "linux" as const, home: "/home/q", binary: "/home/q/.local/bin/suite", intervalSeconds: 60, env: { HOME: "/home/q" } };

  test("the watch unit carries the burrow names, the burrow watch.env and KillMode=process", () => {
    const unit = systemdUnit(input);
    expect(unit).toContain("Description=Burrow agent session watchdog");
    expect(unit).toContain("EnvironmentFile=-/home/q/.config/burrow/watch.env");
    expect(unit).toContain(`\n${KILL_MODE_LINE}\n`);
    expect(unit).not.toContain("Description=Suite");
    expect(SERVICE_NAME).toBe("burrow-watch");
    expect(RESTORE_SERVICE_NAME).toBe("burrow-agents");
  });

  test("the restore unit too, and both plists carry the burrow labels and log paths", () => {
    expect(restoreUnit(input)).toContain("Description=Restore Burrow agent sessions after boot");
    expect(restoreUnit(input)).toContain(`\n${KILL_MODE_LINE}\n`);
    const plist = launchdPlist({ ...input, platform: "darwin" });
    expect(LAUNCHD_LABEL).toBe("technology.milvenan.burrow-watch");
    expect(RESTORE_LAUNCHD_LABEL).toBe("technology.milvenan.burrow-agents");
    expect(plist).toContain("<key>Label</key><string>technology.milvenan.burrow-watch</string>");
    expect(plist).toContain("<string>/home/q/.local/state/burrow-watch.log</string>");
    const restore = restoreLaunchdPlist({ ...input, platform: "darwin" });
    expect(restore).toContain("<string>technology.milvenan.burrow-agents</string>");
    expect(restore).toContain("<string>/home/q/.local/state/burrow-agents.log</string>");
  });

  test("the new unit keeps the old one's binary, interval, PATH and LANG", () => {
    const i = unitInputFrom(OLD_WATCH, "linux", "/home/q", { HOME: "/home/q" });
    expect(i.binary).toBe("/home/q/.local/bin/suite");
    expect(i.intervalSeconds).toBe(90);
    const unit = systemdUnit(i);
    expect(unit).toContain("ExecStart=/home/q/.local/bin/suite watch --interval 90");
    expect(unit).toMatch(/^Environment=PATH=\/opt\/custom\/bin:\/usr\/bin:/m);
    expect(unit).toContain("Environment=LANG=en_GB.UTF-8");
  });
});

describe("systemd: the old units are swapped for burrow-watch and burrow-agents", () => {
  test("an enabled+active watch unit: new enabled, old stopped BEFORE new started, old disabled and retired", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    migrateLegacyState(deps(h, w));
    const sc = callsOf(w, "systemctl").filter((c) => !c.includes(" show ") && !c.includes(" is-"));
    expect(sc.filter((c) => c.includes("watch") || c.endsWith("daemon-reload"))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable burrow-watch.service",
      "systemctl --user stop suite-watch.service",
      "systemctl --user start burrow-watch.service",
      "systemctl --user disable suite-watch.service",
      "systemctl --user daemon-reload",
      // and the agents unit's own write + reloads
      "systemctl --user daemon-reload",
      "systemctl --user daemon-reload",
    ]);
    expect(w.units.get("burrow-watch.service")).toMatchObject({ enabled: true, active: true });
    expect(w.units.get("suite-watch.service")).toMatchObject({ enabled: false, active: false });
    expect(existsSync(join(h.units, "suite-watch.service"))).toBe(false);
    expect(retiredFiles(h.units, "suite-watch.service")).toEqual([`suite-watch.service${RETIRED_SUFFIX}20261018T030000Z`]);
    const unit = readFileSync(join(h.units, "burrow-watch.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile=-${join(h.home, ".config", "burrow", "watch.env")}`);
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("--interval 90");
    expect(unit).not.toContain("/.config/suite/");
    // Positive control for that absence: the retired file does name the old dir.
    expect(readFileSync(join(h.units, retiredFiles(h.units, "suite-watch.service")[0] as string), "utf8")).toContain("/.config/suite/");
  });

  test("a disabled restore unit gets a disabled burrow-agents: never enabled, never started", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    migrateLegacyState(deps(h, w));
    expect(existsSync(join(h.units, "burrow-agents.service"))).toBe(true);
    expect(retiredFiles(h.units, "suite-agents.service").length).toBe(1);
    const agentCalls = callsOf(w, "systemctl").filter((c) => c.includes("burrow-agents") || (c.includes("suite-agents") && !c.includes(" is-")));
    expect(agentCalls).toEqual([]);
    expect(w.units.get("burrow-agents.service")).toBeUndefined();
  });

  test("an enabled+inactive restore unit: enabled across, nothing stopped or started", () => {
    const h = host();
    const w = world();
    seedUnits(h, w, {}, { enabled: true, active: false });
    migrateLegacyState(deps(h, w));
    const sc = callsOf(w, "systemctl");
    expect(sc).toContain("systemctl --user enable burrow-agents.service");
    expect(sc).toContain("systemctl --user disable suite-agents.service");
    expect(sc.some((c) => c.includes("start burrow-agents") || c.includes("stop suite-agents"))).toBe(false);
  });

  test("the second run is a no-op: zero systemctl calls, files unchanged", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "systemctl").length).toBeGreaterThan(0);
    const files = readdirSync(h.units).sort();
    const w2 = world({ units: w.units });
    expect(migrateLegacyState(deps(h, w2)).outcome).toBe("done-already");
    expect(w2.calls).toEqual([]);
    expect(readdirSync(h.units).sort()).toEqual(files);
  });

  test("GUARD A: a tmux pid inside the old unit's cgroup means no stop, a disabled new unit, a breadcrumb, and a retry", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    const cg = w.units.get("suite-watch.service")?.cgroup as string;
    w.tmuxPids = [4242, 4243];
    w.cgroups.set(4242, ["/user.slice/user-1000.slice/session-15251.scope"]);
    w.cgroups.set(4243, [cg]);
    const d = deps(h, w);
    migrateLegacyState(d);
    const sc = callsOf(w, "systemctl");
    expect(sc.some((c) => c.includes(" stop ") || c.includes(" start ") || c.includes(" enable ") || c.includes(" disable "))).toBe(false);
    expect(w.units.get("suite-watch.service")).toMatchObject({ enabled: true, active: true });
    expect(readFileSync(join(h.units, "burrow-watch.service"), "utf8")).toContain("KillMode=process");
    expect(existsSync(join(h.units, "suite-watch.service"))).toBe(true);
    const crumb = readFileSync(join(h.units, `suite-watch.service${BESIDE_BREADCRUMB_SUFFIX}`), "utf8");
    expect(crumb).toContain("tmux pid 4243");
    const st = readState(h);
    expect(st.deferred).toEqual([expect.objectContaining({ step: "unit", path: join(h.units, "suite-watch.service") })]);
    expect(d.errs.some((l) => l.includes("deferred unit"))).toBe(true);

    // The next run retries; once tmux is out of the cgroup it swaps.
    w.cgroups.set(4243, ["/user.slice/user-1000.slice/session-15251.scope"]);
    w.calls = [];
    expect(migrateLegacyState(deps(h, w)).outcome).toBe("ran");
    expect(callsOf(w, "systemctl")).toContain("systemctl --user stop suite-watch.service");
    expect(readState(h).deferred).toEqual([]);
    expect(w.units.get("burrow-watch.service")).toMatchObject({ enabled: true, active: true });
  });

  test("a retry for a deferred unit re-runs the units step ONLY: a suite path written later is never chased", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    w.tmuxPids = [4243];
    w.cgroups.set(4243, [w.units.get("suite-watch.service")?.cgroup as string]);
    migrateLegacyState(deps(h, w));
    expect(readState(h).deferred.length).toBe(1);
    // An older CLI (a dev checkout) registers a channel entry naming the old checkout AFTER the migration ran.
    expect(existsSync(h.newIndex)).toBe(true);
    seedClaudeJson(h);
    w.calls = [];
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "claude")).toEqual([]);
    expect(stubCalls(h)).toEqual([]);
    expect(claudeJson(h).mcpServers["suite-channel"].args).toEqual([h.oldIndex]);
    // Positive control: the units step DID run again on that retry.
    expect(callsOf(w, "systemctl")).toContain("systemctl --user is-active suite-watch.service");
  });

  test("GUARD A positive control: the same host with tmux only in its own scope swaps on the first run", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    w.tmuxPids = [4242, 4243];
    w.cgroups.set(4242, ["/user.slice/user-1000.slice/session-15251.scope"]);
    w.cgroups.set(4243, ["/user.slice/user-1000.slice/session-15251.scope"]);
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "systemctl")).toContain("systemctl --user stop suite-watch.service");
    expect(readState(h).deferred).toEqual([]);
  });

  test("GUARD B: under BURROW_WATCH_SUPERVISED=1 the daemon never stops its own unit, and says so once", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    const d = deps(h, w, { env: { ...h.env, BURROW_WATCH_SUPERVISED: "1" } });
    migrateLegacyState(d);
    const sc = callsOf(w, "systemctl");
    expect(sc.some((c) => c.includes(" stop ") || c.includes(" start "))).toBe(false);
    expect(w.units.get("suite-watch.service")).toMatchObject({ enabled: true, active: true });
    // One stderr line for it, whatever else the run reported.
    expect(d.errs.filter((l) => l.includes("suite-watch"))).toEqual([
      expect.stringMatching(/^burrow: deferred unit .*suite-watch\.service: this process is the watch daemon; it cannot stop its own unit/),
    ]);
    expect(readState(h).deferred).toEqual([expect.objectContaining({ step: "unit", reason: expect.stringContaining("watch daemon") })]);

    // Positive control: the same host, not supervised, swaps.
    w.calls = [];
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "systemctl")).toContain("systemctl --user stop suite-watch.service");
  });

  test("GUARD B by cgroup: a process inside the old unit's cgroup does not stop it", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    w.cgroups.set("self", [w.units.get("suite-watch.service")?.cgroup as string]);
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "systemctl").some((c) => c.includes(" stop "))).toBe(false);
    expect(readState(h).deferred[0]?.reason).toContain("cgroup");
  });

  test("a failed start of the new unit starts the old one again and defers", () => {
    const h = host();
    const w = world();
    seedUnits(h, w);
    w.failOnce.set("systemctl --user start burrow-watch.service", 1);
    migrateLegacyState(deps(h, w));
    expect(w.units.get("suite-watch.service")?.active).toBe(true);
    expect(existsSync(join(h.units, "suite-watch.service"))).toBe(true);
    expect(readState(h).deferred[0]?.reason).toContain("started again");
  });

  test("no systemctl at all: the old file is inert, so it is retired and the new one written", () => {
    const h = host();
    const w = world({ systemctl: false });
    seedUnits(h, w);
    migrateLegacyState(deps(h, w));
    expect(existsSync(join(h.units, "burrow-watch.service"))).toBe(true);
    expect(retiredFiles(h.units, "suite-watch.service").length).toBe(1);
    expect(readState(h).deferred).toEqual([]);
  });
});

describe("launchd: bootout the old label, bootstrap the new plist, retire the old one", () => {
  function seedPlists(h: Host, w: World): string {
    const dir = join(h.home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const input = { platform: "darwin" as const, home: h.home, binary: `${h.home}/.local/bin/suite`, intervalSeconds: 60, env: h.env };
    writeFileSync(join(dir, "technology.milvenan.suite-watch.plist"), launchdPlist(input).replaceAll("burrow-watch", "suite-watch"));
    writeFileSync(join(dir, "technology.milvenan.suite-agents.plist"), restoreLaunchdPlist(input).replaceAll("burrow-agents", "suite-agents"));
    w.launchd.add("technology.milvenan.suite-watch");
    w.launchd.add("technology.milvenan.suite-agents");
    return dir;
  }

  test("loaded watch job: booted out, the new one bootstrapped; the restore job booted out and NOT bootstrapped", () => {
    const h = host();
    const w = world();
    const dir = seedPlists(h, w);
    migrateLegacyState(deps(h, w, { platform: "darwin" }));
    const lc = callsOf(w, "launchctl").filter((c) => !c.includes(" print "));
    expect(lc).toEqual([
      "launchctl bootout gui/501/technology.milvenan.suite-watch",
      `launchctl bootstrap gui/501 ${join(dir, "technology.milvenan.burrow-watch.plist")}`,
      "launchctl bootout gui/501/technology.milvenan.suite-agents",
    ]);
    expect([...w.launchd].sort()).toEqual(["technology.milvenan.burrow-watch"]);
    expect(retiredFiles(dir, "technology.milvenan.suite-watch.plist").length).toBe(1);
    expect(retiredFiles(dir, "technology.milvenan.suite-agents.plist").length).toBe(1);
    expect(existsSync(join(dir, "technology.milvenan.burrow-agents.plist"))).toBe(true);
    expect(readState(h).deferred).toEqual([]);
  });

  test("GUARD B: the supervised daemon writes nothing, so launchd cannot load both at the next login", () => {
    const h = host();
    const w = world();
    const dir = seedPlists(h, w);
    migrateLegacyState(deps(h, w, { platform: "darwin", env: { ...h.env, BURROW_WATCH_SUPERVISED: "1" } }));
    expect(callsOf(w, "launchctl").some((c) => c.includes("bootout gui/501/technology.milvenan.suite-watch"))).toBe(false);
    expect(existsSync(join(dir, "technology.milvenan.burrow-watch.plist"))).toBe(false);
    expect(existsSync(join(dir, "technology.milvenan.suite-watch.plist"))).toBe(true);
  });
});

describe("the no-GUI tmux fallback", () => {
  test("kills only suite-watch, then creates burrow-watch", () => {
    const h = host();
    const w = world({ systemctl: false });
    seedUnits(h, w);
    w.tmuxSessions = new Set(["suite-watch", "suite-oddjob", "suite-agent1"]);
    migrateLegacyState(deps(h, w));
    const tmux = callsOf(w, "tmux").filter((c) => !c.includes("has-session"));
    expect(tmux[0]).toBe("tmux kill-session -t =suite-watch");
    expect(tmux[1]).toStartWith("tmux new-session -d -s burrow-watch");
    expect(tmux[1]).toContain("watch --interval 90");
    expect([...w.tmuxSessions].sort()).toEqual(["burrow-watch", "suite-agent1", "suite-oddjob"]);
  });

  test("a host where 0.8 never installed a watchdog never touches tmux at all", () => {
    const h = host();
    const w = world();
    w.tmuxSessions = new Set(["suite-watch"]);
    migrateLegacyState(deps(h, w));
    expect(callsOf(w, "tmux")).toEqual([]);
    expect(w.tmuxSessions.has("suite-watch")).toBe(true);
  });
});

describe("supervisor.ts leaves the swap to the migration", () => {
  function io(existing: string[]): SupervisorIo & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      mkdirp: (d) => void calls.push(`mkdirp ${d}`),
      writeFile: (p) => void calls.push(`write ${p}`),
      run: async (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: 0 };
      },
      exists: (p) => existing.includes(p),
    };
  }
  const input = { platform: "linux" as const, home: "/home/q", binary: "/home/q/.local/bin/suite", intervalSeconds: 60 };

  test("while suite-watch.service is still installed, nothing is written or started", async () => {
    const i = io(["/home/q/.config/systemd/user/suite-watch.service", "/home/q/.config/systemd/user/suite-agents.service"]);
    const res = await installSupervisor(i, supervisorPlan(input));
    expect(res).toMatchObject({ installed: false, deferred: true });
    expect(i.calls).toEqual([]);
    const ens = await ensureSupervision(i, input);
    expect(ens.watchdog).toStartWith("deferred: ");
    expect(ens.restore).toBeNull();
    expect(i.calls).toEqual([]);
  });

  test("positive control: once it is retired, burrow-watch is written and enabled", async () => {
    const i = io([]);
    const res = await installSupervisor(i, supervisorPlan(input));
    expect(res.installed).toBe(true);
    expect(i.calls).toContain("systemctl --user enable --now burrow-watch.service");
  });
});

describe("the probe helpers", () => {
  test("cgroup v2 and v1 lines parse to their paths", () => {
    expect(parseCgroupFile("0::/user.slice/app.slice/suite-watch.service\n")).toEqual(["/user.slice/app.slice/suite-watch.service"]);
    expect(parseCgroupFile("12:pids:/user.slice\n1:name=systemd:/user.slice/session-3.scope\n")).toEqual(["/user.slice", "/user.slice/session-3.scope"]);
  });
});
