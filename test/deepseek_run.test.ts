/**
 * `suite deepseek` end to end through `runDeepseek`, with the harness, tmux
 * and exec faked.
 *
 * Pins the three things that broke reaching a running agent from its folder:
 *
 *   A. the cwd was ignored: `cd ~/agents/oddjob && suite deepseek` fell back
 *      to the machine config and said "Run `suite init` first", although the
 *      folder carried its own burrow.json and credentials
 *   B. the agent root's `.burrow-state.json` `env` block was never read, so
 *      OPENROUTER_API_KEY (and DSH_MODEL, DSH_PERMISSION_MODE, ...) never
 *      reached dsh, and every turn failed with MISSING_CREDENTIAL
 *   C. from the folder, a LIVE session must be attached to and a STALE one
 *      recycled, the same three-way handling `suite claude` does
 *
 * Every value below is fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeepseekDeps, runDeepseek } from "../src/commands/deepseek.ts";
import type { RestoreDeps } from "../src/commands/restore.ts";
import type { RunResult, TmuxDeps } from "../src/tmux.ts";
import type { Prompter } from "../src/secrets.ts";

const FAKE_TOKEN = "fake-runtime-token-0001";
const FAKE_OR_KEY = "fake-openrouter-key-0002";
const FAKE_GW_KEY = "fake-gateway-key-0003";
const SECRETS = [FAKE_TOKEN, FAKE_OR_KEY, FAKE_GW_KEY];

const SAVED = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMUX", "DSH_PERMISSION_MODE", "OPENROUTER_API_KEY", "DSH_MODEL"];
let saved: Record<string, string | undefined> = {};
let base = "";
let root = "";

function writeAgent(dir: string, runtimeId: string, env: Record<string, string> | undefined): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "burrow.json"),
    JSON.stringify({ suiteUrl: "https://suite.example.invalid", runtimeId, headerNames: [] }),
  );
  writeFileSync(
    join(dir, ".burrow-state.json"),
    JSON.stringify({ token: FAKE_TOKEN, headers: {}, ...(env === undefined ? {} : { env }) }),
    { mode: 0o600 },
  );
}

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  base = mkdtempSync(join(tmpdir(), "suite-deepseek-run-"));
  // No machine config anywhere: the only way to succeed is the agent root.
  process.env.HOME = join(base, "home");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.XDG_DATA_HOME = join(base, "data");
  for (const k of ["TMUX", "DSH_PERMISSION_MODE", "OPENROUTER_API_KEY", "DSH_MODEL"]) delete process.env[k];
  // A harness that "is installed" — runDeepseek only checks the bin exists.
  const bin = join(base, "data", "suite", "deepseek", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "dsh"), "#!/bin/sh\n");
  root = join(base, "home", "agents", "oddjob");
  writeAgent(root, "oddjob-dsh", {
    OPENROUTER_API_KEY: FAKE_OR_KEY,
    KOBO_GATEWAY_KEY: FAKE_GW_KEY,
    DSH_PROVIDER: "openrouter",
    DSH_MODEL: "z-ai/fake-model",
    DSH_CONTEXT_WINDOW: "4096",
    DSH_PERMISSION_MODE: "danger-full-access",
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

interface Captured {
  stderr: string;
  execs: Array<{ argv: string[]; cwd: string; env: Record<string, string> }>;
  tmuxCalls: string[][];
  rosters: Array<{ path: string; contents: string }>;
}

function fakeTmux(state: "live" | "stale" | "none", calls: string[][]): TmuxDeps {
  return {
    env: {},
    which: (name) => (name === "tmux" ? "/usr/bin/tmux" : null),
    run: async (argv): Promise<RunResult> => {
      calls.push(argv);
      if (argv[1] === "list-panes") {
        if (state === "none") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "suite-oddjob\t100\tbun\n", stderr: "" };
      }
      if (argv[0] === "ps") {
        const rows = ["100 1 bun bun cli.ts deepseek --root /x --no-session"];
        if (state === "live") rows.push("101 100 node node /h/node_modules/.bin/dsh --profile headless");
        return { exitCode: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(opts: {
  cwd: string;
  tty?: boolean;
  tmux?: "live" | "stale" | "none";
  /** Inject a capturing restore, so launch-recording is observable. */
  restore?: boolean;
}): { d: DeepseekDeps; c: Captured } {
  const c: Captured = { stderr: "", execs: [], tmuxCalls: [], rosters: [] };
  const restore: RestoreDeps = {
    tmux: fakeTmux(opts.tmux ?? "none", c.tmuxCalls),
    readRoster: () => null,
    writeRoster: (p, contents) => void c.rosters.push({ path: p, contents: String(contents) }),
    now: () => new Date("2026-10-08T00:00:00Z"),
    log: () => {},
  };
  const d: DeepseekDeps = {
    which: () => null,
    isTTY: () => opts.tty ?? false,
    run: async () => 0,
    exec: async (argv, o) => {
      c.execs.push({ argv, cwd: o.cwd, env: o.env });
      return 0;
    },
    stderr: { write: (t) => void (c.stderr += t) },
    cwd: () => opts.cwd,
    ...(opts.tmux === undefined ? {} : { tmux: fakeTmux(opts.tmux, c.tmuxCalls) }),
    ...(opts.restore ? { restore } : {}),
  };
  return { d, c };
}

describe("A: the cwd is the agent root when it carries burrow.json", () => {
  test("run from the agent folder with no --root and no machine config, it starts as that agent", async () => {
    const { d, c } = deps({ cwd: root });
    const code = await runDeepseek(["--no-session"], d);
    expect(c.stderr).not.toContain("burrow init");
    expect(code).toBe(0);
    expect(c.execs).toHaveLength(1);
    expect(c.execs[0]?.cwd).toBe(root);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
    expect(c.execs[0]?.env.DSH_HOME).toBe(join(root, ".dsh"));
  });

  test("--root still wins over a cwd that is a different agent", async () => {
    const other = join(base, "home", "agents", "other");
    writeAgent(other, "other-dsh", undefined);
    const { d, c } = deps({ cwd: other });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
  });

  test("an ancestor of an agent root is not that agent: machine-config fallback, named", async () => {
    const { d, c } = deps({ cwd: join(base, "home", "agents") });
    expect(await runDeepseek(["--no-session"], d)).toBe(1);
    expect(c.stderr).toContain("burrow init");
    expect(c.execs).toHaveLength(0);
  });
});

describe("D: no saved connection — the init prompts run inline, never 'run burrow init first'", () => {
  function scripted(answers: string[], asked: string[]): Prompter {
    const q = [...answers];
    return {
      ask: async (question) => (asked.push(question), q.shift() ?? ""),
      askSecret: async (question) => (asked.push(question), q.shift() ?? ""),
      say: () => {},
    };
  }

  test("from a terminal, it asks for url, runtime id and token, saves them, and starts", async () => {
    const asked: string[] = [];
    const { d, c } = deps({ cwd: join(base, "home", "agents"), tty: true });
    d.prompter = scripted(["https://suite.example.invalid", "inline-dsh", FAKE_TOKEN, ""], asked);

    const code = await runDeepseek(["--no-session"], d);

    expect(asked.some((q) => q.startsWith("burrow url"))).toBe(true);
    expect(asked.some((q) => q.startsWith("runtime id"))).toBe(true);
    expect(asked.some((q) => q.startsWith("token"))).toBe(true);
    expect(code).toBe(0);
    expect(c.execs).toHaveLength(1);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("inline-dsh");
    expect(c.execs[0]?.env.SUITE_RUNTIME_TOKEN).toBe(FAKE_TOKEN);
    // Saved for next time: a second run asks nothing.
    const again: string[] = [];
    const second = deps({ cwd: join(base, "home", "agents"), tty: true });
    second.d.prompter = scripted([], again);
    expect(await runDeepseek(["--no-session"], second.d)).toBe(0);
    expect(again).toEqual([]);
  });

  test("CONTROL: off a terminal there is nobody to ask, so it refuses and names the way out", async () => {
    const asked: string[] = [];
    const { d, c } = deps({ cwd: join(base, "home", "agents"), tty: false });
    d.prompter = scripted(["https://suite.example.invalid", "inline-dsh", FAKE_TOKEN, ""], asked);
    expect(await runDeepseek(["--no-session"], d)).toBe(1);
    expect(asked).toEqual([]);
    expect(c.stderr).toContain("burrow init");
    // Names the folder that is not connected, not "this machine": the
    // connection is per agent folder.
    expect(c.stderr).toContain(`${join(base, "home", "agents")} is not connected to Burrow yet`);
    expect(c.stderr).toContain(`burrow init --dir ${join(base, "home", "agents")}`);
    expect(c.stderr).not.toContain("this machine");
    expect(c.execs).toHaveLength(0);
  });
});

describe("B: the agent root's env block reaches the harness", () => {
  test("the model key and DSH_ settings are in the child env; no secret is in argv", async () => {
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    const run = c.execs[0];
    expect(run?.env.OPENROUTER_API_KEY).toBe(FAKE_OR_KEY);
    expect(run?.env.KOBO_GATEWAY_KEY).toBe(FAKE_GW_KEY);
    expect(run?.env.DSH_MODEL).toBe("z-ai/fake-model");
    expect(run?.env.DSH_CONTEXT_WINDOW).toBe("4096");
    expect(run?.env.SUITE_RUNTIME_TOKEN).toBe(FAKE_TOKEN);
    const argv = (run?.argv ?? []).join(" ");
    for (const s of SECRETS) expect(argv).not.toContain(s);
    expect(c.stderr).not.toContain("MISSING_CREDENTIAL");
  });

  test("the agent's DSH_PERMISSION_MODE beats the workspace-write default and the inherited env", async () => {
    process.env.DSH_PERMISSION_MODE = "read-only";
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.execs[0]?.env.DSH_PERMISSION_MODE).toBe("danger-full-access");
  });

  test("without a declared key the run says so instead of failing every turn silently", async () => {
    writeAgent(root, "oddjob-dsh", undefined);
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.stderr).toContain("OPENROUTER_API_KEY is not set");
    expect(c.execs[0]?.env.DSH_PERMISSION_MODE).toBe("workspace-write");
  });

  test("the generated patch declares the model DSH_MODEL selects, by expression", async () => {
    const { d } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    const patch = await Bun.file(join(root, ".dsh", "burrow.patch.yml")).text();
    expect(patch).toContain("- id: !!js process.env.DSH_MODEL || 'moonshotai/kimi-k3'");
    for (const s of SECRETS) expect(patch).not.toContain(s);
  });
});

describe("C: from the agent folder, a live session is attached and a stale one recycled", () => {
  test("LIVE: attaches, creates nothing", async () => {
    const { d, c } = deps({ cwd: root, tty: true, tmux: "live" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.stderr).toContain("attaching to suite-oddjob");
    expect(c.tmuxCalls.some((a) => a[1] === "new-session" || a[1] === "kill-session")).toBe(false);
    expect(c.execs.map((e) => e.argv)).toEqual([["tmux", "attach-session", "-t", "suite-oddjob"]]);
  });

  test("STALE: kills that one session, relaunches the CLI with --root and no secret in argv", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "stale" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.stderr).toContain("recycling stale session suite-oddjob");
    expect(c.tmuxCalls).toContainEqual(["tmux", "kill-session", "-t", "suite-oddjob"]);
    const created = c.tmuxCalls.find((a) => a[1] === "new-session") ?? [];
    expect(created.join(" ")).toContain(`deepseek --root ${root} --no-session`);
    for (const s of SECRETS) expect(created.join(" ")).not.toContain(s);
    // The agent in the 0.8 session was gone: it comes back under the burrow name.
    expect(created.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "burrow-oddjob"]);
  });

  test("the fake tmux above holds only the 0.8 name: LIVE attached to suite-oddjob with no burrow-oddjob created", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "live" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.tmuxCalls.filter((a) => a.includes("burrow-oddjob") && a[1] !== "list-panes")).toEqual([]);
    expect(c.stderr).toContain("suite-oddjob is running detached");
  });

  test("positive control: with no session at all, the launch creates burrow-oddjob", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "none" });
    expect(await runDeepseek([], d)).toBe(0);
    const created = c.tmuxCalls.filter((a) => a[1] === "new-session");
    expect(created).toHaveLength(1);
    expect(created[0]?.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "burrow-oddjob"]);
    expect(c.stderr).toContain("started burrow-oddjob");
  });
});

describe("D: launches are recorded for restore-on-boot", () => {
  test("a created deepseek session is recorded with its full tmux argv", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "none", restore: true });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.rosters).toHaveLength(1);
    // Parsed as the same JSON `suite restore` reads back — a shape drift here
    // is a launch that silently never restores.
    const roster = JSON.parse(c.rosters[0]?.contents ?? "{}");
    expect(roster.agents).toHaveLength(1);
    // The session name derives from the agent root's basename; deriving it
    // here keeps the assertion tied to the fixture instead of a literal. A
    // NEW session takes the burrow- prefix (stage 3 of 01a14cc3; PR #36 wrote
    // this test against the 0.8 suite- prefix, and the merge is where they met).
    expect(roster.agents[0]).toMatchObject({
      kind: "deepseek",
      session: `burrow-${root.split("/").pop()}`,
      cwd: root,
    });
    // The FULL tmux argv, replayed verbatim at restore time. Rebuilding the
    // command at restore time is where a recovery quietly starts something
    // subtly different from what was running.
    expect(String(roster.agents[0]?.command.join(" "))).toContain(
      `deepseek --root ${root} --no-session`,
    );
  });

  test("attaching to a live session records nothing", async () => {
    // Restore-on-boot replays launches. A re-attach is not one, and recording
    // it would mark every attach as a fresh launch.
    const { d, c } = deps({ cwd: root, tty: true, tmux: "live", restore: true });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.rosters).toHaveLength(0);
  });

  test("no injected restore records nothing", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "none" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.rosters).toHaveLength(0);
    // And the create itself still happened — the assertion is that recording
    // stayed absent, not the launch.
    expect(c.tmuxCalls.some((a) => a[1] === "new-session")).toBe(true);
  });
});

describe("0.10.2: a pre-0.10.2 root is renamed on its first run, then found", () => {
  /** Put the agent back as 0.10.1 left it: the `suite` names, and a stale patch. */
  function legacy(dir: string): void {
    renameSync(join(dir, "burrow.json"), join(dir, "suite.json"));
    renameSync(join(dir, ".burrow-state.json"), join(dir, ".suite-state.json"));
    mkdirSync(join(dir, ".dsh"), { recursive: true });
    writeFileSync(join(dir, ".dsh", "suite.patch.yml"), "stale: true\n");
  }

  test("from the agent folder (cwd), with no --root: renamed, found, started with its own key; state stays 0600", async () => {
    legacy(root);
    const { d, c } = deps({ cwd: root });
    expect(await runDeepseek(["--no-session"], d)).toBe(0);
    for (const n of ["suite.json", ".suite-state.json", join(".dsh", "suite.patch.yml")]) expect(existsSync(join(root, n))).toBe(false);
    expect(existsSync(join(root, "burrow.json"))).toBe(true);
    expect(statSync(join(root, ".burrow-state.json")).mode & 0o777).toBe(0o600);
    expect(c.stderr).toContain(`renamed ${join(root, "suite.json")} -> ${join(root, "burrow.json")}`);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
    expect(c.execs[0]?.env.OPENROUTER_API_KEY).toBe(FAKE_OR_KEY);
    const patch = join(root, ".dsh", "burrow.patch.yml");
    expect(c.execs[0]?.argv).toContain(patch);
    expect(readFileSync(patch, "utf8")).not.toBe("stale: true\n");
  });

  test("with --root: the same", async () => {
    legacy(root);
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(existsSync(join(root, "suite.json"))).toBe(false);
    expect(c.execs[0]?.env.OPENROUTER_API_KEY).toBe(FAKE_OR_KEY);
  });

  test("both names present: refused, both named, nothing renamed, nothing started", async () => {
    copyFileSync(join(root, "burrow.json"), join(root, "suite.json"));
    const { d, c } = deps({ cwd: root });
    expect(await runDeepseek(["--no-session"], d)).toBe(1);
    expect(c.stderr).toContain(join(root, "suite.json"));
    expect(c.stderr).toContain(join(root, "burrow.json"));
    expect(c.execs).toHaveLength(0);
    expect(existsSync(join(root, "suite.json"))).toBe(true);
  });
});

describe("0.10.3: only a run that STARTS the agent renames its root", () => {
  // 2026-10-20, hive: a watchdog re-ran `burrow deepseek` against oddjob's
  // live session. 0.10.2 renamed the root first, and the running dsh was left
  // holding `--patch .../.dsh/suite.patch.yml`, a path that no longer existed.
  const OLD = ["suite.json", ".suite-state.json", join(".dsh", "suite.patch.yml")];
  const NEW = ["burrow.json", ".burrow-state.json", join(".dsh", "burrow.patch.yml")];
  const LIVE_PATCH = "running: true\n";

  function legacy(dir: string): void {
    renameSync(join(dir, "burrow.json"), join(dir, "suite.json"));
    renameSync(join(dir, ".burrow-state.json"), join(dir, ".suite-state.json"));
    mkdirSync(join(dir, ".dsh"), { recursive: true });
    writeFileSync(join(dir, ".dsh", "suite.patch.yml"), LIVE_PATCH);
  }

  for (const how of [
    { label: "from the agent folder", args: [] as string[], cwd: () => root },
    { label: "with --root", args: () => ["--root", root], cwd: () => base },
  ]) {
    test(`ATTACH to a live session (${how.label}): the old names stay, no new name appears, nothing is written`, async () => {
      legacy(root);
      const args = typeof how.args === "function" ? how.args() : how.args;
      const { d, c } = deps({ cwd: how.cwd(), tty: false, tmux: "live" });
      expect(await runDeepseek(args, d)).toBe(0);
      // It did attach: the outcome under test is "attached AND renamed nothing".
      expect(c.stderr).toContain("attaching to suite-oddjob");
      expect(c.tmuxCalls.some((a) => a[1] === "new-session")).toBe(false);
      for (const n of OLD) expect(existsSync(join(root, n))).toBe(true);
      for (const n of NEW) expect(existsSync(join(root, n))).toBe(false);
      expect(readFileSync(join(root, ".dsh", "suite.patch.yml"), "utf8")).toBe(LIVE_PATCH);
      expect(c.stderr).not.toContain("renamed");
    });
  }

  test("START of a new session (none running): renamed before the session is created", async () => {
    legacy(root);
    const { d, c } = deps({ cwd: root, tty: false, tmux: "none" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.tmuxCalls.filter((a) => a[1] === "new-session")).toHaveLength(1);
    expect(c.stderr).toContain(`renamed ${join(root, "suite.json")} -> ${join(root, "burrow.json")}`);
    expect(c.stderr.indexOf("renamed")).toBeLessThan(c.stderr.indexOf("started burrow-oddjob"));
    for (const n of OLD) expect(existsSync(join(root, n))).toBe(false);
    for (const n of ["burrow.json", ".burrow-state.json", join(".dsh", "burrow.patch.yml")]) expect(existsSync(join(root, n))).toBe(true);
    expect(statSync(join(root, ".burrow-state.json")).mode & 0o777).toBe(0o600);
  });

  test("START replacing a STALE session (its agent is gone): renamed", async () => {
    legacy(root);
    const { d, c } = deps({ cwd: root, tty: false, tmux: "stale" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.tmuxCalls.filter((a) => a[1] === "new-session")).toHaveLength(1);
    expect(existsSync(join(root, "suite.json"))).toBe(false);
    expect(existsSync(join(root, "burrow.json"))).toBe(true);
  });

  test("a start that finds both names is refused before tmux is asked to create anything", async () => {
    copyFileSync(join(root, "burrow.json"), join(root, "suite.json"));
    const { d, c } = deps({ cwd: root, tty: false, tmux: "none" });
    expect(await runDeepseek([], d)).toBe(1);
    expect(c.stderr).toContain("both exist");
    expect(c.tmuxCalls.some((a) => a[1] === "new-session")).toBe(false);
    expect(existsSync(join(root, "suite.json"))).toBe(true);
  });

  test("an attach to a live, already-renamed root writes no patch either", async () => {
    // The 0.10.2 outer run rewrote .dsh/burrow.patch.yml on every attach; the
    // tmux child (the start) is now the only writer.
    const { d } = deps({ cwd: root, tty: false, tmux: "live" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(existsSync(join(root, ".dsh", "burrow.patch.yml"))).toBe(false);
  });
});
