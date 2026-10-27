/**
 * session.restart and session.tools (task 01a17b1c stage 4).
 *
 * END TO END on a real tmux (private socket dir): a fake `claude`
 * (test/fixtures/fake-claude) that, like the real one, loads only the APPROVED
 * `.mcp.json` servers at start and records its pid, argv and loaded tools; a
 * fake stdio MCP server (test/fixtures/fake_mcp_server.ts). Start with server
 * A, add server B through file.write (with its approval), then session.restart:
 * the process is new, `--continue` is still in its argv, it loaded B, and the
 * reply's diff is exactly B's tools.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { killSessionArgv, liveTmuxDeps, newSessionArgv } from "../src/tmux.ts";
import { paneCommand } from "../src/commands/claude.ts";
import { rosterPath, serializeRoster, type RosterEntry } from "../src/roster.ts";
import { liveSessionOps } from "../src/host/live.ts";
import { HostOps, sha256, type Reply } from "../src/host/ops.ts";
import { SessionOps } from "../src/host/session.ts";
import { paneCommandOf, respawnArgv, resumes, restartSession } from "../src/session_restart.ts";
import { claudeServers, codexServers, diffTools, snapshotTools } from "../src/host/tools.ts";
import { helloFor } from "../src/host/manager.ts";
import type { ConfigAccess } from "../src/host/access.ts";

const ROOT = mkdtempSync(resolve(tmpdir(), "burrow-restart-"));
const SOCKET_DIR = resolve(ROOT, "sock");
const BIN = resolve(ROOT, "bin");
const HOME = resolve(ROOT, "home");
const OUT = resolve(ROOT, "out");
for (const d of [SOCKET_DIR, BIN, HOME, OUT]) mkdirSync(d);

const FAKE_CLAUDE = resolve(import.meta.dir, "fixtures/fake-claude");
const FAKE_MCP = resolve(import.meta.dir, "fixtures/fake_mcp_server.ts");
const MCP_LOG = resolve(OUT, "mcp.log");

const ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME,
  PATH: `${BIN}:${process.env.PATH ?? ""}`,
  TMUX_TMPDIR: SOCKET_DIR,
  TMUX: "",
  FAKE_CLAUDE_OUT: OUT,
  XDG_STATE_HOME: resolve(HOME, ".local/state"),
};
const tmux = liveTmuxDeps(ENV);
const HAVE_TMUX = tmux.which("tmux") !== null;
const sessions = new Set<string>();

afterAll(async () => {
  for (const s of sessions) await tmux.run(killSessionArgv(s));
  rmSync(ROOT, { recursive: true, force: true });
});

// `claude` on PATH execs the fixture, so the pane's process IS the fake (exec keeps the pid).
writeFileSync(resolve(BIN, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
chmodSync(resolve(BIN, "claude"), 0o755);

const server = (tools: string) => ({ command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_TOOLS: tools, FAKE_MCP_LOG: MCP_LOG } });
const okOf = (r: Reply | null): Record<string, unknown> => {
  if (r === null) throw new Error("no reply");
  if ("error" in r) throw new Error(`error reply: ${r.error}`);
  return r.ok;
};

interface Launch {
  pid: number;
  argv: string[];
  tools: string[];
}
const launches = (): Launch[] => {
  const p = resolve(OUT, "launches.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Launch) : [];
};
async function waitFor<T>(fn: () => T | null | undefined, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

describe("restart: argv and resume (pure)", () => {
  const entry = (command: string[], kind: RosterEntry["kind"] = "claude"): RosterEntry => ({ session: "burrow-x", command, cwd: "/w", kind, recordedAt: "" });

  test("the pane command is everything after tmux's options, the wrapper and --continue kept", () => {
    const pane = paneCommand([]);
    const recorded = newSessionArgv({ session: "burrow-x", cwd: "/w", command: pane });
    expect(paneCommandOf(recorded)).toEqual(pane);
    const argv = respawnArgv(entry(recorded))!;
    expect(argv.slice(0, 7)).toEqual(["tmux", "respawn-pane", "-k", "-t", "=burrow-x:", "-c", "/w"]);
    expect(argv.slice(7)).toEqual(pane);
    expect(argv).toContain("--continue");
    expect(argv[7]).toBe("/bin/sh"); // the no-conversation fallback wrapper
  });

  test("a recorded value that starts with - is skipped as an option value, not taken as the command", () => {
    expect(paneCommandOf(["tmux", "new-session", "-d", "-s", "-odd", "-c", "/w", "codex", "--x"])).toEqual(["codex", "--x"]);
    expect(paneCommandOf(["tmux", "attach"])).toBeNull();
    expect(paneCommandOf(["tmux", "new-session", "-d", "-s", "n"])).toBeNull();
  });

  test("resumed: claude with --continue, codex always, others never", () => {
    expect(resumes(entry(["tmux", "new-session", "-d", "-s", "s", "claude", "--continue"]))).toBe(true);
    expect(resumes(entry(["tmux", "new-session", "-d", "-s", "s", "claude"]))).toBe(false);
    expect(resumes(entry(["tmux", "new-session", "-d", "-s", "s", "bun", "cli.ts", "codex", "--no-session"], "codex"))).toBe(true);
    expect(resumes(entry(["tmux", "new-session", "-d", "-s", "s", "hermes"], "hermes"))).toBe(false);
  });

  test("a session that is not running is refused, and nothing is respawned", async () => {
    const calls: string[][] = [];
    const r = await restartSession(
      { tmux: { which: () => "tmux", run: async (argv) => (calls.push(argv), { exitCode: 1, stdout: "", stderr: "" }) } },
      entry(["tmux", "new-session", "-d", "-s", "s", "claude"]),
    );
    expect(r).toEqual({ ok: false, reason: "not_running" });
    expect(calls.some((c) => c.includes("respawn-pane"))).toBe(false);
  });
});

describe("session ops: refusals and the opt-in", () => {
  const snap = { taken_at: "t", servers: [], tools: [] };
  const sessionOps = (entry: RosterEntry | null) =>
    new SessionOps({
      entry: () => entry,
      harness: () => "claude_code",
      panePid: async () => 42,
      restart: async () => ({ ok: true, outcome: "ready", resumed: true, pid_before: 42, pid_after: 43 }),
      snapshot: async () => snap,
      baselinePath: (s) => resolve(ROOT, `${s}.base.json`),
    });
  const hostOps = (access: ConfigAccess, entry: RosterEntry | null) => new HostOps({ root: ROOT, access: () => access, session: sessionOps(entry) });
  const e: RosterEntry = { session: "burrow-y", command: ["tmux", "new-session", "-d", "-s", "burrow-y", "claude"], cwd: ROOT, kind: "claude", recordedAt: "" };

  test("no recorded session: refused", async () => {
    expect(await hostOps("owner_only", null).handle("session.restart", { actor_role: "owner" })).toEqual({ error: "no_recorded_session" });
  });
  test("access off: no reply at all; owner_only refuses an admin; admins allows one", async () => {
    expect(await hostOps("off", e).handle("session.restart", { actor_role: "owner" })).toBeNull();
    expect(await hostOps("owner_only", e).handle("session.restart", { actor_role: "admin" })).toEqual({ error: "forbidden" });
    expect(await hostOps("owner_only", e).handle("session.restart", {})).toEqual({ error: "forbidden" });
    expect(okOf(await hostOps("admins", e).handle("session.restart", { actor_role: "admin" }))["outcome"]).toBe("ready");
  });
  test("without session ops the events answer unsupported", async () => {
    expect(await new HostOps({ root: ROOT, access: () => "admins" }).handle("session.restart", { actor_role: "owner" })).toEqual({ error: "unsupported" });
  });
  test("the hello advertises the session capability", () => {
    expect(helloFor("claude_code", "owner_only")["capabilities"]).toEqual(["file", "session", "file.delete"]);
  });
});

describe("tool snapshot", () => {
  test("only approved .mcp.json servers; codex enabled=false skipped", () => {
    const d = mkdtempSync(resolve(ROOT, "cfg-"));
    mkdirSync(resolve(d, ".claude"));
    mkdirSync(resolve(d, ".codex"));
    writeFileSync(resolve(d, ".mcp.json"), JSON.stringify({ mcpServers: { A: server("a"), B: server("b"), C: server("c") } }));
    writeFileSync(resolve(d, ".claude/settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["A", "C"], disabledMcpjsonServers: ["C"] }));
    expect(claudeServers(d).map((s) => s.name)).toEqual(["A"]);
    writeFileSync(resolve(d, ".codex/config.toml"), `[mcp_servers.x]\ncommand = "x"\n\n[mcp_servers.y]\ncommand = "y"\nenabled = false\n`);
    expect(codexServers(d).map((s) => s.name)).toEqual(["x"]);
  });

  test("a server that does not answer is unreachable:<name>, never dropped; no secret value in the snapshot", async () => {
    const d = mkdtempSync(resolve(ROOT, "snap-"));
    mkdirSync(resolve(d, ".claude"));
    const probe = `probe-${crypto.randomUUID()}`;
    writeFileSync(
      resolve(d, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          A: { ...server("a_one,a_two"), env: { ...server("").env, FAKE_MCP_TOOLS: "a_one,a_two", API_KEY: probe } },
          Q: { ...server("q"), env: { FAKE_MCP_SILENT: "1", TOKEN: probe } },
          H: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${probe}` } },
        },
      }),
    );
    writeFileSync(resolve(d, ".claude/settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    const s = await snapshotTools("claude_code", d, { env: ENV, timeoutMs: 1_500 });
    expect(s.tools).toEqual(["A/a_one", "A/a_two", "unreachable:H", "unreachable:Q"]);
    expect(JSON.stringify(s)).not.toContain(probe);
  });

  test("diff", () => {
    expect(diffTools(["A/x", "A/y"], ["A/x", "B/z"])).toEqual({ added: ["B/z"], removed: ["A/y"] });
  });
});

describe("guard: no terminal bytes on the restart path", () => {
  test("src/host and src/session_restart.ts never type into or read a pane", () => {
    const files = [
      ...readdirSync(resolve(import.meta.dir, "../src/host")).filter((f) => f.endsWith(".ts")).map((f) => resolve(import.meta.dir, "../src/host", f)),
      resolve(import.meta.dir, "../src/session_restart.ts"),
    ];
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect({ f, pane: /send-keys|capture-pane|paste-buffer|forceRecover|dialogKeysArgv|dialogCaptureArgv/.test(code) }).toEqual({ f, pane: false });
    }
    expect(/send-keys/.test('"send-keys"')).toBe(true); // positive control
  });
});

describe.skipIf(!HAVE_TMUX)("end to end on a real tmux", () => {
  test(
    "start with A, add B via file.write with approval, restart: new pid, --continue kept, loaded = before + B, diff = +B",
    async () => {
      const dir = mkdtempSync(resolve(ROOT, "agent-"));
      mkdirSync(resolve(dir, ".claude"));
      writeFileSync(resolve(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { A: server("a_ping") } }, null, 2)}\n`);
      writeFileSync(resolve(dir, ".claude/settings.local.json"), `${JSON.stringify({ enabledMcpjsonServers: ["A"] }, null, 2)}\n`);

      const session = `burrow-restart-${process.pid}`;
      const recorded = newSessionArgv({ session, cwd: dir, command: paneCommand([]) });
      recorded[0] = tmux.which("tmux")!;
      const created = await tmux.run(recorded);
      expect(created.exitCode).toBe(0);
      sessions.add(session);
      const rosterFile = rosterPath(HOME, ENV);
      mkdirSync(resolve(rosterFile, ".."), { recursive: true });
      writeFileSync(rosterFile, serializeRoster([{ session, command: recorded, cwd: dir, kind: "claude", recordedAt: new Date().toISOString() }]));

      const first = await waitFor(() => launches()[0]);
      expect(first.tools).toEqual(["A/a_ping"]);
      expect(first.argv).toContain("--continue");

      const sess = liveSessionOps(ENV, dir);
      const ops = new HostOps({ root: dir, access: () => "owner_only", session: sess });
      await sess.observe(); // the watch pass's baseline: what the running process loaded

      // Add B through the host, exactly as the Burrow install does: the server and its approval.
      const owner = { actor_role: "owner" };
      const mcpNow = readFileSync(resolve(dir, ".mcp.json"));
      const nextMcp = { mcpServers: { A: server("a_ping"), B: server("b_ping,b_echo") } };
      const w1 = okOf(await ops.handle("file.write", { ...owner, path: ".mcp.json", content: `${JSON.stringify(nextMcp, null, 2)}\n`, expected_sha256: sha256(mcpNow) }));
      expect(w1["status"]).toBe("ok");
      if (process.env.MUTATION_DROP_APPROVAL !== "1") {
        const setNow = readFileSync(resolve(dir, ".claude/settings.local.json"));
        const w2 = okOf(
          await ops.handle("file.write", {
            ...owner,
            path: ".claude/settings.local.json",
            content: `${JSON.stringify({ enabledMcpjsonServers: ["A", "B"] }, null, 2)}\n`,
            expected_sha256: sha256(setNow),
          }),
        );
        expect(w2["status"]).toBe("ok");
      }

      const reply = okOf(await ops.handle("session.restart", owner));
      const second = await waitFor(() => launches()[1]);

      expect(second.pid).not.toBe(first.pid);
      expect(second.argv).toContain("--continue");
      expect(second.tools).toEqual(["A/a_ping", "B/b_echo", "B/b_ping"]);
      const addedByProcess = second.tools.filter((t) => !first.tools.includes(t));
      expect(addedByProcess).toEqual(["B/b_echo", "B/b_ping"]);

      expect(reply["outcome"]).toBe("ready");
      expect(reply["resumed"]).toBe(true);
      expect(reply["relaunched"]).toBe(true);
      expect(reply["before_basis"]).toBe("loaded");
      expect((reply["before"] as { tools: string[] }).tools).toEqual(first.tools);
      expect((reply["after"] as { tools: string[] }).tools).toEqual(second.tools);
      expect(reply["diff"]).toEqual({ added: addedByProcess, removed: [] });
    },
    120_000,
  );
});
