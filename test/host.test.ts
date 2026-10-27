/**
 * The config host (src/host): scoping, atomic conflict-checked writes, on-machine
 * redaction, the per-agent opt-in, and the connection (task 01a17b1c stage 3).
 *
 * Every value is invented; the probe is a fresh uuid per test and is compared
 * in-test, never printed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readAgentRecordExact, writeAgentConnection, type AgentRecord } from "../src/agent_connections.ts";
import { ENABLEABLE_KINDS, parseAccess, permits, setConfigAccess, type ConfigAccess } from "../src/host/access.ts";
import { HostManager, helloFor, topicName } from "../src/host/manager.ts";
import { codexHomeOf, harnessOf } from "../src/host/live.ts";
import { HostOps, sha256, type Reply } from "../src/host/ops.ts";
import { redactForRead, restore } from "../src/host/redact.ts";
import { scope } from "../src/host/scope.ts";
import type { SocketLike } from "../src/codex/phoenix.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(label: string): string {
  const d = mkdtempSync(resolve(tmpdir(), `host-${label}-`));
  dirs.push(d);
  return d;
}

const probe = () => `probe-${crypto.randomUUID()}`;

function put(root: string, rel: string, body: string): void {
  const full = resolve(root, rel);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function ops(root: string, access: ConfigAccess = "admins", extra: Partial<ConstructorParameters<typeof HostOps>[0]> = {}): HostOps {
  return new HostOps({ root, access: () => access, ...extra });
}

const owner = { actor_role: "owner" };
async function ask(o: HostOps, event: string, payload: Record<string, unknown>): Promise<Reply> {
  const r = await o.handle(event, { ...owner, ...payload });
  if (r === null) throw new Error("no reply");
  return r;
}
const okOf = (r: Reply): Record<string, unknown> => ("ok" in r ? r.ok : (() => { throw new Error(`error reply: ${r.error}`); })());

describe("scope: nothing outside the agent folder", () => {
  test("traversal, absolute, home-relative and odd paths are refused before any open", () => {
    const root = tmp("scope");
    for (const rel of ["../x", "a/../../x", "/etc/passwd", "~/.ssh/id", "~agent/x", "", ".", "..", "a//b", "a/b/c/d/e", "a\\b", "a\0b", "a b"]) {
      expect(scope(root, rel)).toEqual({ ok: false, reason: "invalid_path" });
    }
    expect(scope(root, 42).ok).toBe(false);
  });

  test("a symlink to outside the root is refused as a final component", () => {
    const root = tmp("scope");
    const outside = tmp("outside");
    writeFileSync(resolve(outside, "secret.txt"), "outside");
    symlinkSync(resolve(outside, "secret.txt"), resolve(root, "CLAUDE.md"));
    expect(scope(root, "CLAUDE.md")).toEqual({ ok: false, reason: "symlink" });
  });

  test("a symlinked ancestor directory that leaves the root is refused, and nothing is read or written", async () => {
    const root = tmp("scope");
    const outside = tmp("outside");
    writeFileSync(resolve(outside, "settings.json"), '{"outside":true}');
    symlinkSync(outside, resolve(root, ".claude"));
    expect(scope(root, ".claude/settings.json")).toEqual({ ok: false, reason: "outside_root" });

    const o = ops(root);
    expect(await ask(o, "file.read", { path: ".claude/settings.json" })).toEqual({ error: "outside_root" });
    expect(await ask(o, "file.write", { path: ".claude/new.md", content: "x", expected_sha256: null })).toEqual({ error: "outside_root" });
    expect(readdirSync(outside)).toEqual(["settings.json"]);
    expect(readFileSync(resolve(outside, "settings.json"), "utf8")).toBe('{"outside":true}');
  });

  test("an ancestor that does not exist yet is fine when the root holds it", () => {
    const root = tmp("scope");
    expect(scope(root, ".claude/skills/x/SKILL.md")).toMatchObject({ ok: true, exists: false });
  });
});

describe("atomic, conflict-checked writes", () => {
  test("create-only, then update with the current hash", async () => {
    const root = tmp("w");
    const o = ops(root);
    const created = okOf(await ask(o, "file.write", { path: "CLAUDE.md", content: "# one\n", expected_sha256: null }));
    expect(created).toEqual({ status: "ok", sha256: sha256("# one\n") });
    const again = okOf(await ask(o, "file.write", { path: "CLAUDE.md", content: "# two\n", expected_sha256: null }));
    expect(again).toEqual({ status: "conflict", current_sha256: sha256("# one\n") });
    const upd = okOf(await ask(o, "file.write", { path: "CLAUDE.md", content: "# two\n", expected_sha256: sha256("# one\n") }));
    expect(upd["status"]).toBe("ok");
    expect(readFileSync(resolve(root, "CLAUDE.md"), "utf8")).toBe("# two\n");
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a stale hash is refused and the file is unchanged", async () => {
    const root = tmp("w");
    put(root, "CLAUDE.md", "# on the machine\n");
    const r = okOf(await ask(ops(root), "file.write", { path: "CLAUDE.md", content: "# mine\n", expected_sha256: sha256("# stale\n") }));
    expect(r).toEqual({ status: "conflict", current_sha256: sha256("# on the machine\n") });
    expect(readFileSync(resolve(root, "CLAUDE.md"), "utf8")).toBe("# on the machine\n");
  });

  test("a change between the hash and the rename is refused (injected hook)", async () => {
    const root = tmp("w");
    put(root, "CLAUDE.md", "# v1\n");
    const o = ops(root, "admins", { beforeRehash: (full) => writeFileSync(full, "# changed by the agent mid-write\n") });
    const r = okOf(await ask(o, "file.write", { path: "CLAUDE.md", content: "# mine\n", expected_sha256: sha256("# v1\n") }));
    expect(r["status"]).toBe("conflict");
    expect(readFileSync(resolve(root, "CLAUDE.md"), "utf8")).toBe("# changed by the agent mid-write\n");
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("over 512 KiB is refused", async () => {
    const root = tmp("w");
    const r = await ask(ops(root), "file.write", { path: "big.md", content: "x".repeat(512 * 1024 + 1), expected_sha256: null });
    expect(r).toEqual({ error: "too_large" });
  });

  test("two writes racing on one path serialise: exactly one wins", async () => {
    const root = tmp("w");
    put(root, "CLAUDE.md", "# v0\n");
    const o = ops(root);
    const base = sha256("# v0\n");
    const [a, b] = await Promise.all([
      ask(o, "file.write", { path: "CLAUDE.md", content: "# a\n", expected_sha256: base }),
      ask(o, "file.write", { path: "CLAUDE.md", content: "# b\n", expected_sha256: base }),
    ]);
    const statuses = [okOf(a)["status"], okOf(b)["status"]].sort();
    expect(statuses).toEqual(["conflict", "ok"]);
  });
});

describe("secrets never leave the machine", () => {
  function seed(root: string, p: string): void {
    put(root, ".env", `API_KEY=${p}\nOTHER=${p}\n`);
    put(
      root,
      ".mcp.json",
      JSON.stringify({ mcpServers: { srv: { command: "x", env: { FAKE_TOKEN: p, OK: "${OK}" }, headers: { "X-Key": p } } } }),
    );
    put(root, ".codex/config.toml", `# my comment\nmodel = "m"\n\n[mcp_servers.srv]\nurl = "https://x.invalid"\nbearer_token = "${p}"\n\n[mcp_servers.srv.http_headers]\nX-Key = "${p}"\n\n[mcp_servers.s2]\ncommand = "c"\nenv = { A = "${p}" }\n`);
    put(root, ".claude/.credentials.json", JSON.stringify({ oauth: { token: p } }));
  }

  test("no list, read, or error reply holds the probe; the names are there", async () => {
    const root = tmp("s");
    const p = probe();
    seed(root, p);
    const o = ops(root);
    const replies: unknown[] = [await ask(o, "file.list", {})];
    for (const path of [".env", ".mcp.json", ".codex/config.toml", ".claude/.credentials.json"]) replies.push(await ask(o, "file.read", { path }));
    replies.push(await ask(o, "file.write", { path: ".env", content: `A=${p}`, expected_sha256: null }));
    expect(JSON.stringify(replies)).not.toContain(p);

    const env = okOf(replies[1] as Reply)["content"] as string;
    expect(env).toBe("API_KEY\nOTHER\n");
    const mcp = okOf(replies[2] as Reply)["content"] as string;
    expect(mcp).toContain("FAKE_TOKEN");
    expect(mcp).toContain("X-Key");
    expect(mcp).toContain("${OK}");
    const toml = okOf(replies[3] as Reply)["content"] as string;
    expect(toml).toContain("# my comment");
    expect(toml).toContain("[mcp_servers.srv.http_headers]");
    expect(toml).toContain('bearer_token = "[redacted]"');
    expect(okOf(replies[4] as Reply)["content"]).toBe("oauth.token\n");
  });

  test("the precondition hash is over the full on-disk bytes", async () => {
    const root = tmp("s");
    const p = probe();
    seed(root, p);
    const r = okOf(await ask(ops(root), "file.read", { path: ".mcp.json" }));
    expect(r["sha256"]).toBe(sha256(readFileSync(resolve(root, ".mcp.json"))));
  });

  test("a write of the redacted .mcp.json keeps the secrets on disk", async () => {
    const root = tmp("s");
    const p = probe();
    seed(root, p);
    const o = ops(root);
    const read = okOf(await ask(o, "file.read", { path: ".mcp.json" }));
    const edited = (read["content"] as string).replace('"command": "x"', '"command": "y"');
    const w = okOf(await ask(o, "file.write", { path: ".mcp.json", content: edited, expected_sha256: read["sha256"] }));
    expect(w["status"]).toBe("ok");
    const disk = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8")) as { mcpServers: { srv: { command: string; env: Record<string, string>; headers: Record<string, string> } } };
    expect(disk.mcpServers.srv.command).toBe("y");
    expect(disk.mcpServers.srv.env["FAKE_TOKEN"]).toBe(p);
    expect(disk.mcpServers.srv.headers["X-Key"]).toBe(p);
  });

  test("a redacted config.toml round trip keeps comments, order and the secrets", async () => {
    const root = tmp("s");
    const p = probe();
    seed(root, p);
    const before = readFileSync(resolve(root, ".codex/config.toml"), "utf8");
    const o = ops(root);
    const read = okOf(await ask(o, "file.read", { path: ".codex/config.toml" }));
    const edited = (read["content"] as string).replace('model = "m"', 'model = "n"');
    okOf(await ask(o, "file.write", { path: ".codex/config.toml", content: edited, expected_sha256: read["sha256"] }));
    expect(readFileSync(resolve(root, ".codex/config.toml"), "utf8")).toBe(before.replace('model = "m"', 'model = "n"'));
  });

  test("a placeholder with no stored value is refused, not saved as a value", async () => {
    const root = tmp("s");
    const r = await ask(ops(root), "file.write", { path: ".mcp.json", content: '{"mcpServers":{"a":{"env":{"K":"[redacted]"}}}}', expected_sha256: null });
    expect(r).toEqual({ error: "unresolved_redaction" });
    expect(existsSync(resolve(root, ".mcp.json"))).toBe(false);
    expect(restore(".codex/config.toml", '[a.env]\nK = "[redacted]"\n', null)).toEqual({ ok: false, reason: "unresolved_redaction" });
  });

  test("secret.set changes the disk value, is write-only, and later reads still hide it", async () => {
    const root = tmp("s");
    const p = probe();
    seed(root, p);
    const o = ops(root);
    const fresh = probe();
    for (const [path, pointer, needle] of [
      [".env", "API_KEY", `API_KEY=${fresh}`],
      [".mcp.json", "mcpServers/srv/env/FAKE_TOKEN", fresh],
      [".codex/config.toml", "mcp_servers/srv/bearer_token", fresh],
    ] as const) {
      const r = await ask(o, "secret.set", { path, pointer, value: fresh });
      expect(JSON.stringify(r)).not.toContain(fresh);
      expect(readFileSync(resolve(root, path), "utf8")).toContain(needle);
      const read = await ask(o, "file.read", { path });
      expect(JSON.stringify(read)).not.toContain(fresh);
    }
  });

  test("secret.set is refused for an ordinary file", async () => {
    const root = tmp("s");
    expect(await ask(ops(root), "secret.set", { path: "CLAUDE.md", pointer: "X", value: "v" })).toEqual({ error: "not_a_secret_file" });
  });
});

describe("the opt-in, per agent folder", () => {
  test("off: every op is dropped without a reply", async () => {
    const root = tmp("a");
    put(root, "CLAUDE.md", "x");
    const o = ops(root, "off");
    for (const ev of ["file.list", "file.read", "file.write", "secret.set"]) expect(await o.handle(ev, owner)).toBeNull();
  });

  test("owner_only refuses an admin actor and serves the owner", async () => {
    const root = tmp("a");
    put(root, "CLAUDE.md", "x");
    const o = ops(root, "owner_only");
    expect(await o.handle("file.read", { actor_role: "admin", path: "CLAUDE.md" })).toEqual({ error: "forbidden" });
    expect(await o.handle("file.read", { actor_role: "other", path: "CLAUDE.md" })).toEqual({ error: "forbidden" });
    expect(await o.handle("file.read", { path: "CLAUDE.md" })).toEqual({ error: "forbidden" });
    expect(okOf((await o.handle("file.read", { actor_role: "owner", path: "CLAUDE.md" }))!)["content"]).toBe("x");
  });

  test("admins allows an admin actor, still not a stranger", async () => {
    const root = tmp("a");
    put(root, "CLAUDE.md", "x");
    const o = ops(root, "admins");
    expect(okOf((await o.handle("file.read", { actor_role: "admin", path: "CLAUDE.md" }))!)["content"]).toBe("x");
    expect(await o.handle("file.read", { actor_role: "member", path: "CLAUDE.md" })).toEqual({ error: "forbidden" });
  });

  test("permits() is the whole table", () => {
    const table: [ConfigAccess, unknown, boolean][] = [
      ["off", "owner", false], ["off", "admin", false],
      ["owner_only", "owner", true], ["owner_only", "admin", false],
      ["admins", "owner", true], ["admins", "admin", true], ["admins", "x", false], ["admins", undefined, false],
    ];
    for (const [a, r, want] of table) expect(permits(a, r)).toBe(want);
  });

  test("the setting is saved in the agent's record and survives re-init; a kind that is not the owner's own cannot be enabled", () => {
    const home = tmp("rec");
    const agent = resolve(home, "agent");
    mkdirSync(agent);
    const env = { HOME: home };
    const noRepo = { repoRoot: () => null, isIgnored: () => false };
    const conn = { suiteUrl: "https://one.example.invalid", runtimeId: "rt-a-00000000", headerNames: [] as string[] };
    writeAgentConnection(env, agent, conn, { token: "tok", headers: {} }, { probe: noRepo });

    expect(setConfigAccess(env, agent, "owner_only")).toEqual({ ok: true, access: "owner_only" });
    expect(readAgentRecordExact(env, agent)?.record.configAccess).toBe("owner_only");
    writeAgentConnection(env, agent, conn, { token: "tok", headers: {} }, { probe: noRepo });
    expect(readAgentRecordExact(env, agent)?.record.configAccess).toBe("owner_only");

    const refused = setConfigAccess(env, agent, "admins", "other_federation");
    expect(refused.ok).toBe(false);
    expect(readAgentRecordExact(env, agent)?.record.configAccess).toBe("owner_only");
    expect(ENABLEABLE_KINDS).toEqual(["own_agent_in_member_install"]);
    expect(setConfigAccess(env, agent, "off", "other_federation")).toEqual({ ok: true, access: "off" });
    expect(readAgentRecordExact(env, agent)?.record.configAccess).toBeUndefined();
    expect(setConfigAccess(env, resolve(home, "nowhere"), "admins").ok).toBe(false);
  });

  test("CLI spellings", () => {
    expect(["off", "owner", "owner_only", "admins", "admin", "wat"].map(parseAccess)).toEqual(["off", "owner_only", "owner_only", "admins", "admins", null]);
  });
});

describe("codex home outside the root", () => {
  test("is reported unavailable, not followed", async () => {
    const root = tmp("c");
    const elsewhere = tmp("codexhome");
    put(root, ".codex/config.toml", 'model = "m"\n');
    const o = ops(root, "admins", { codexHome: () => elsewhere });
    expect(await ask(o, "file.read", { path: ".codex/config.toml" })).toEqual({ error: "unavailable" });
    expect(await ask(o, "file.write", { path: ".codex/config.toml", content: "x", expected_sha256: null })).toEqual({ error: "unavailable" });
    const list = okOf(await ask(o, "file.list", {}))["entries"] as { path: string }[];
    expect(list.some((e) => e.path.startsWith(".codex/"))).toBe(false);
    const home = ops(root, "admins", { codexHome: () => resolve(root, ".codex") });
    expect(okOf(await ask(home, "file.read", { path: ".codex/config.toml" }))["content"]).toBe('model = "m"\n');
    expect(codexHomeOf({ command: ["bun", "cli.ts", "codex", "--codex-home", "/x/y"], cwd: "/a", kind: "codex", session: "s", recordedAt: "" })).toBe("/x/y");
    expect(codexHomeOf(null)).toBeNull();
    expect(harnessOf(null)).toBe("claude_code");
  });
});

describe("file.list reports config files only", () => {
  test("known paths, skills, no other file in the work tree", async () => {
    const root = tmp("l");
    put(root, "CLAUDE.md", "a");
    put(root, ".claude/skills/s1/SKILL.md", "b");
    put(root, ".claude/agents/r.md", "c");
    put(root, ".env.local", "K=v");
    put(root, "src/app.ts", "code");
    const entries = okOf(await ask(ops(root), "file.list", {}))["entries"] as { path: string; secret: boolean }[];
    expect(entries.map((e) => e.path)).toEqual([".claude/agents/r.md", ".claude/skills/s1/SKILL.md", ".env.local", "CLAUDE.md"]);
    expect(entries.find((e) => e.path === ".env.local")?.secret).toBe(true);
  });
});

// ---- the connection --------------------------------------------------------

class FakeServerSocket implements SocketLike {
  readyState = 0;
  sent: unknown[][] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)) as unknown[]);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverPush(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("connection: join, hello, serve", () => {
  function setup(access: ConfigAccess | null) {
    const home = tmp("conn");
    const agent = resolve(home, "agent");
    mkdirSync(agent);
    const env = { HOME: home };
    const token = `tok-${crypto.randomUUID()}`;
    writeAgentConnection(env, agent, { suiteUrl: "https://one.example.invalid", runtimeId: "rt-a-00000000", headerNames: [] }, { token, headers: {} }, { probe: { repoRoot: () => null, isIgnored: () => false } });
    if (access !== null) setConfigAccess(env, agent, access);
    const sockets: FakeServerSocket[] = [];
    const logs: string[] = [];
    const timers: (() => void)[] = [];
    const mgr = new HostManager({
      env,
      socket: (url) => {
        const s = new FakeServerSocket(url);
        sockets.push(s);
        return s;
      },
      log: (l) => logs.push(l),
      harnessFor: () => "claude_code",
      codexHomeFor: () => null,
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
    });
    return { mgr, agent: resolve(agent), sockets, logs, token, env, timers };
  }

  test("access off: no socket is opened at all", () => {
    const { mgr, sockets } = setup("off");
    mgr.sync();
    expect(sockets).toHaveLength(0);
    expect(mgr.connected()).toEqual([]);
  });

  test("never-set access reads as off", () => {
    const { mgr, sockets } = setup(null);
    mgr.sync();
    expect(sockets).toHaveLength(0);
  });

  test("joins runtime_host:<id> with a hello, serves file.read by ref, and never logs the token", async () => {
    const { mgr, sockets, logs, token, agent } = setup("owner_only");
    writeFileSync(resolve(agent, "CLAUDE.md"), "# hello\n");
    mgr.sync();
    expect(sockets).toHaveLength(1);
    const s = sockets[0]!;
    expect(s.url).toContain("/runtime/ws/websocket");
    expect(s.url).toContain("runtime_id=rt-a-00000000");
    s.open();
    const join = s.sent.find((f) => f[3] === "phx_join")!;
    expect(join[2]).toBe(topicName("rt-a-00000000"));
    expect(join[4]).toMatchObject({ harness: "claude_code", capabilities: ["file", "session"], resumes: true, config_opt_in: "owner_only" });
    expect((join[4] as { cli_version: string }).cli_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(helloFor("codex", "admins")).toMatchObject({ harness: "codex", config_opt_in: "admins" });

    s.serverPush([join[0], join[1], join[2], "phx_reply", { status: "ok", response: {} }]);
    s.serverPush([null, null, join[2], "file.read", { ref: "r1", path: "CLAUDE.md", actor_role: "owner" }]);
    await new Promise((r) => setTimeout(r, 20));
    const reply = s.sent.find((f) => f[3] === "reply")!;
    expect(reply[4]).toEqual({ ref: "r1", ok: { content: "# hello\n", sha256: sha256("# hello\n") } });

    s.serverPush([null, null, join[2], "file.read", { ref: "r2", path: "CLAUDE.md", actor_role: "admin" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.sent.filter((f) => f[3] === "reply")[1]![4]).toEqual({ ref: "r2", error: "forbidden" });

    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).toContain("REDACTED");
  });

  test("a push for another topic, or an unknown event, is ignored", async () => {
    const { mgr, sockets } = setup("admins");
    mgr.sync();
    const s = sockets[0]!;
    s.open();
    const join = s.sent.find((f) => f[3] === "phx_join")!;
    s.serverPush([join[0], join[1], join[2], "phx_reply", { status: "ok", response: {} }]);
    s.serverPush([null, null, "terminal:rt-a-00000000", "file.read", { ref: "x", path: "CLAUDE.md", actor_role: "owner" }]);
    s.serverPush([null, null, join[2], "terminal.data", { ref: "y" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.sent.filter((f) => f[3] === "reply")).toEqual([]);
  });

  test("switching access off closes the connection on the next sync; a dropped socket reconnects", () => {
    const { mgr, sockets, agent, env, timers } = setup("admins");
    mgr.sync();
    expect(mgr.connected()).toEqual([agent]);
    sockets[0]!.open();
    sockets[0]!.close();
    expect(timers.length).toBeGreaterThan(0);
    timers.at(-1)!();
    expect(sockets).toHaveLength(2);

    setConfigAccess(env, agent, "off");
    mgr.sync();
    expect(mgr.connected()).toEqual([]);
  });

  test("the terminal can attach another topic to the same socket", () => {
    const { mgr, sockets, agent } = setup("admins");
    mgr.sync();
    const sock = mgr.socketFor(agent)!;
    sock.topic("terminal:rt-a-00000000", () => ({}));
    sockets[0]!.open();
    const topics = sockets[0]!.sent.filter((f) => f[3] === "phx_join").map((f) => f[2]);
    expect(topics.sort()).toEqual(["runtime_host:rt-a-00000000", "terminal:rt-a-00000000"]);
    expect(sockets).toHaveLength(1);
  });
});

describe("guard: the host never reaches a terminal", () => {
  const files = readdirSync(resolve(import.meta.dir, "../src/host")).filter((f) => f.endsWith(".ts"));

  test("no file in src/host imports tmux.ts or names a pane operation", () => {
    expect(files.length).toBeGreaterThan(4); // positive control: the scan reads real files
    for (const f of files) {
      const text = readFileSync(resolve(import.meta.dir, "../src/host", f), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect({ f, tmux: /from\s+["'][^"']*tmux(\.ts)?["']/.test(code) }).toEqual({ f, tmux: false });
      expect({ f, pane: /send-keys|capture-pane|respawn-pane|paste-buffer/.test(code) }).toEqual({ f, pane: false });
    }
    // positive control for the pattern itself
    expect(/from\s+["'][^"']*tmux(\.ts)?["']/.test('import { x } from "../tmux.ts";')).toBe(true);
  });
});

describe("redaction unit", () => {
  test("JSON env/headers and `${REF}`", () => {
    const p = probe();
    const r = redactForRead(".claude/settings.json", JSON.stringify({ env: { A: p, B: "${B}" }, model: "m" }));
    expect(r.shown).not.toContain(p);
    expect(r.shown).toContain("${B}");
    expect(r.names).toEqual(["A"]);
    expect(redactForRead("CLAUDE.md", "# x").shown).toBe("# x");
  });
});

// keep the type import used
void (undefined as unknown as AgentRecord);
