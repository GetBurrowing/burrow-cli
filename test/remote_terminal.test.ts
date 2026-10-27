import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseClaudeOptions, usage } from "../src/cli.ts";
import { agentArgv, runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import { emptyConfig } from "../src/config.ts";
import { createStore } from "../src/secrets.ts";
import { PhoenixChannel, decodeBinaryFrame, encodeBinaryPush, type SocketLike } from "../src/codex/phoenix.ts";
import { TerminalBridge, attachClientArgv, type BridgeChannel } from "../src/terminal/bridge.ts";
import {
  DIR_BROWSER_TO_CLI,
  DIR_CLI_TO_BROWSER,
  KIND_CONTROL,
  KIND_DATA,
  Receiver,
  Sender,
  deriveKeys,
  fromB64,
  generateKeyPair,
  openFrame,
  publicKeyOf,
  sealFrame,
  toB64,
} from "../src/terminal/crypto.ts";
import { livePty, type PtyHandle, type SpawnPty } from "../src/terminal/pty.ts";
import { ENABLEABLE_KINDS, FEDERATION_OWN_AGENT, remoteTerminalPermission } from "../src/terminal/permission.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readAgentRecordExact, writeAgentConnection } from "../src/agent_connections.ts";
import { ENABLEABLE_KINDS as HOST_ENABLEABLE_KINDS, setConfigAccess } from "../src/host/access.ts";
import { HostManager } from "../src/host/manager.ts";
import { HostSocket } from "../src/host/socket.ts";
import { launchRemoteTerminal, remoteTerminalOf, setRemoteTerminal } from "../src/terminal/host.ts";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (s: string) => new TextEncoder().encode(s);

/* ---------------------------------------------------------------- launch */

const homes: string[] = [];
function connectedFolder() {
  const home = mkdtempSync(resolve(tmpdir(), "rt-home-"));
  homes.push(home);
  const agent = resolve(home, "ledger");
  mkdirSync(agent);
  const env = { HOME: home };
  writeAgentConnection(env, agent, { suiteUrl: "https://one.example.invalid", runtimeId: "rt-a-00000000", headerNames: [] }, { token: `tok-${crypto.randomUUID()}`, headers: {} }, { probe: { repoRoot: () => null, isIgnored: () => false } });
  return { env, agent: resolve(agent) };
}
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function launch(remoteTerminal: boolean | undefined) {
  const folder = connectedFolder();
  const ran: string[][] = [];
  const err: string[] = [];
  let session: string | null = null;
  const deps: ClaudeDeps = {
    tmux: {
      env: {},
      which: () => "/usr/bin/tmux",
      run: async (argv) => {
        ran.push(argv);
        const ok = { exitCode: 0, stdout: "", stderr: "" };
        if (argv.includes("has-session")) return { ...ok, exitCode: 1 };
        if (argv.includes("new-session") && session === null) session = argv[argv.indexOf("-s") + 1] ?? null;
        if (argv.includes("list-panes")) return { ...ok, stdout: session === null ? "" : `${session}\t4242\tzsh\n` };
        if (argv[0] === "ps") return { ...ok, stdout: "  4242     1 zsh              -zsh\n  4243  4242 claude           claude --continue\n" };
        return ok;
      },
    },
    platform: "darwin",
    prompter: { ask: async () => "n", askSecret: async () => "", say: () => {} },
    sleep: async () => {},
    env: folder.env,
    cwd: folder.agent,
    store: createStore(),
    config: emptyConfig(),
    statePath: resolve("/tmp", `rt-state-${Math.random().toString(36).slice(2)}.json`),
    color: false,
    out: () => {},
    err: (l) => err.push(l),
    exec: async () => 0,
  };
  const options = { userArgs: [] as string[], force: false, ...(remoteTerminal === undefined ? {} : { remoteTerminal }) };
  const marker = () => {
    const found = readAgentRecordExact(folder.env, folder.agent);
    return found === null ? null : remoteTerminalOf(found.record);
  };
  return { deps, ran, err, options, folder, marker, agentSession: () => session };
}

describe("--remote-terminal flag", () => {
  test("absent: nothing is recorded, no second session is started and no terminal topic is joined", async () => {
    const r = launch(undefined);
    await runClaude(r.deps, r.options);
    expect(r.ran.filter((a) => a.includes("new-session"))).toHaveLength(1);
    expect(r.ran.flat().some((a) => a.includes("terminal"))).toBe(false);
    expect(r.marker()).toBeNull();
    expect(r.err.join("\n")).not.toContain("remote terminal");
    expect(parseClaudeOptions(["--resume"]).remoteTerminal).toBeUndefined();
  });

  test("present: the opt-in is recorded for the agent session, and no process is started for it", async () => {
    const r = launch(true);
    await runClaude(r.deps, r.options);
    // The terminal rides the watcher's shared socket: nothing new is spawned here.
    expect(r.ran.filter((a) => a.includes("new-session"))).toHaveLength(1);
    expect(r.marker()).toBe(r.agentSession());
    expect(r.err.join("\n")).toContain("burrow watch");
  });

  test("the opt-in is per launch: a launch without the flag clears the last one", async () => {
    const r = launch(true);
    await runClaude(r.deps, r.options);
    expect(r.marker()).not.toBeNull();
    await runClaude(r.deps, { ...r.options, remoteTerminal: undefined });
    expect(r.marker()).toBeNull();
  });

  test("--remote-terminal never reaches Claude's argv", async () => {
    const parsed = parseClaudeOptions(["--remote-terminal", "--model", "x"]);
    expect(parsed.remoteTerminal).toBe(true);
    expect(parsed.rest).toEqual(["--model", "x"]);
    expect(agentArgv(parsed.rest)).not.toContain("--remote-terminal");
    const r = launch(true);
    await runClaude(r.deps, { ...r.options, userArgs: parsed.rest });
    const agentNew = r.ran.find((a) => a.includes("new-session")) ?? [];
    expect(agentNew).not.toContain("--remote-terminal");
    // After `--` the word is Claude's, as every other wrapper option is.
    expect(parseClaudeOptions(["--", "--remote-terminal"])).toEqual({ rest: ["--", "--remote-terminal"] });
  });

  test("no launch argv anywhere carries kill-session or kill-server", async () => {
    const r = launch(true);
    await runClaude(r.deps, r.options);
    expect(r.ran.flat().some((a) => /kill-(session|server)/.test(a))).toBe(false);
  });

  test("help says what the flag is, and says nothing about signing in or a sandbox", () => {
    const help = usage();
    expect(help).toContain("--remote-terminal");
    expect(help).toContain("a shell as you");
    expect(help.toLowerCase()).not.toContain("login");
    expect(help.toLowerCase()).not.toContain("sandbox");
    expect(help).not.toContain("terminal-bridge");
  });
});

/* ---------------------------------------------------------------- crypto */

const V = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/terminal_crypto_v1.json"), "utf8"));

describe("terminal crypto vectors", () => {
  const cliKeys = deriveKeys("cli", hex(V.cli_private_hex), hex(V.browser_public_hex), V.session_id);
  const brKeys = deriveKeys("browser", hex(V.browser_private_hex), hex(V.cli_public_hex), V.session_id);

  test("public keys and both directional keys match the file", () => {
    expect(toHex(publicKeyOf(hex(V.cli_private_hex)))).toBe(V.cli_public_hex);
    expect(toHex(publicKeyOf(hex(V.browser_private_hex)))).toBe(V.browser_public_hex);
    expect(toHex(cliKeys.send)).toBe(V.key_cli_to_browser_hex);
    expect(toHex(cliKeys.recv)).toBe(V.key_browser_to_cli_hex);
    expect(toHex(brKeys.send)).toBe(V.key_browser_to_cli_hex);
  });

  test("every recorded frame is reproduced and opens to its plaintext", () => {
    for (const f of V.out_frames) {
      const plain = new Uint8Array([f.kind, ...hex(f.plaintext_hex)]);
      expect(toHex(sealFrame(cliKeys.send, DIR_CLI_TO_BROWSER, BigInt(f.counter), plain))).toBe(f.frame_hex);
      const opened = openFrame(brKeys.recv, DIR_CLI_TO_BROWSER, hex(f.frame_hex));
      expect(toHex(opened.plaintext)).toBe(toHex(plain));
    }
    for (const f of V.in_frames) {
      const opened = openFrame(cliKeys.recv, DIR_BROWSER_TO_CLI, hex(f.frame_hex));
      expect(toHex(opened.plaintext.subarray(1))).toBe(f.plaintext_hex);
    }
  });

  test("agrees with WebCrypto, which is what the browser runs", async () => {
    const f = V.out_frames[1];
    const frame = hex(f.frame_hex);
    const key = await crypto.subtle.importKey("raw", hex(V.key_cli_to_browser_hex), "AES-GCM", false, ["decrypt"]);
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(0, V.direction_ids.cli_to_browser);
    nonce.set(frame.subarray(0, 8), 4);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, frame.subarray(8)));
    expect(toHex(plain)).toBe(toHex(new Uint8Array([f.kind, ...hex(f.plaintext_hex)])));
  });

  test("a replayed or reordered counter is rejected", () => {
    const send = new Sender(cliKeys.send, DIR_CLI_TO_BROWSER);
    const f0 = send.seal(KIND_DATA, text("a"));
    const f1 = send.seal(KIND_DATA, text("b"));
    const f2 = send.seal(KIND_DATA, text("c"));
    const recv = new Receiver(brKeys.recv, DIR_CLI_TO_BROWSER);
    expect(recv.open(f0)?.body).toEqual(text("a"));
    expect(recv.open(f0)).toBeNull(); // replay
    expect(recv.open(f2)?.body).toEqual(text("c"));
    expect(recv.open(f1)).toBeNull(); // reordered
  });

  test("a forged frame fails and does not advance the counter", () => {
    const send = new Sender(cliKeys.send, DIR_CLI_TO_BROWSER);
    const f0 = send.seal(KIND_DATA, text("a"));
    const forged = new Uint8Array(f0);
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 1;
    const recv = new Receiver(brKeys.recv, DIR_CLI_TO_BROWSER);
    expect(recv.open(forged)).toBeNull();
    expect(recv.open(f0)?.body).toEqual(text("a"));
  });

  test("fresh key pairs agree", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = deriveKeys("cli", a.privateKey, b.publicKey, "s");
    const kb = deriveKeys("browser", b.privateKey, a.publicKey, "s");
    expect(toHex(ka.send)).toBe(toHex(kb.recv));
  });
});

/* ---------------------------------------------------------------- phoenix */

describe("phoenix V2 binary frames", () => {
  // Recorded from Phoenix 1.8.5's Phoenix.Socket.V2.JSONSerializer.
  const CLIENT_PUSH = "0001020c033134327465726d696e616c3a7274316f7574050607c8";
  const SERVER_PUSH = "00010c02317465726d696e616c3a727431696e010203ff";
  const SERVER_REPLY = "0101010c0231377465726d696e616c3a7274316f6b0908";

  test("our client push encoding is the recorded frame", () => {
    expect(toHex(encodeBinaryPush("1", "42", "terminal:rt1", "out", new Uint8Array([5, 6, 7, 200])))).toBe(CLIENT_PUSH);
  });

  test("the recorded server push and reply decode", () => {
    expect(decodeBinaryFrame(hex(SERVER_PUSH))).toEqual({ kind: "push", joinRef: "1", topic: "terminal:rt1", event: "in", payload: new Uint8Array([1, 2, 3, 255]) });
    expect(decodeBinaryFrame(hex(SERVER_REPLY))).toEqual({ kind: "reply", joinRef: "1", ref: "7", topic: "terminal:rt1", status: "ok", payload: new Uint8Array([9, 8]) });
    expect(decodeBinaryFrame(hex("00ff"))).toBeNull();
  });

  test("a channel sends binary pushes and dispatches binary server pushes", () => {
    const sent: unknown[] = [];
    let ws!: SocketLike;
    const ch = new PhoenixChannel({
      url: "ws://x/websocket",
      topic: "terminal:rt1",
      joinPayload: {},
      log: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
      socket: () => {
        ws = { readyState: 1, send: (d) => sent.push(d), close() {}, onopen: null, onclose: null, onerror: null, onmessage: null };
        return ws;
      },
    });
    const got: Uint8Array[] = [];
    let dropped = 0;
    ch.onBinary("in", (b) => got.push(b));
    ch.onDropped(() => dropped++);
    ch.connect();
    expect(ch.pushBinary("out", new Uint8Array([1]))).toBe(false); // not joined yet
    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify(["1", "1", "terminal:rt1", "phx_reply", { status: "ok", response: {} }]) });
    expect(ch.pushBinary("out", new Uint8Array([5, 6, 7, 200]))).toBe(true);
    const frame = sent[sent.length - 1] as Uint8Array;
    expect(toHex(frame)).toBe(toHex(encodeBinaryPush("1", "2", "terminal:rt1", "out", new Uint8Array([5, 6, 7, 200]))));
    ws.onmessage?.({ data: hex(SERVER_PUSH).buffer });
    expect(got).toEqual([new Uint8Array([1, 2, 3, 255])]);
    ws.onclose?.({});
    expect(dropped).toBe(1);
  });
});

/* ---------------------------------------------------------------- bridge */

function rig() {
  const handlers = new Map<string, (p: Record<string, unknown>) => void>();
  const binary = new Map<string, (b: Uint8Array) => void>();
  const pushed: { event: string; payload: Record<string, unknown> }[] = [];
  const out: Uint8Array[] = [];
  let dropFn: () => void = () => {};
  const channel: BridgeChannel = {
    on: (e, fn) => void handlers.set(e, fn),
    onBinary: (e, fn) => void binary.set(e, fn),
    onDropped: (fn) => void (dropFn = fn),
    push: async (event, payload) => void pushed.push({ event, payload }),
    pushBinary: (_e, b) => (out.push(b), true),
  };
  const spawns: { argv: string[]; env: Record<string, string>; written: Uint8Array[]; sizes: [number, number][]; killed: boolean; emit(b: Uint8Array): void }[] = [];
  const spawn: SpawnPty = (argv, opts, onData) => {
    const rec = { argv, env: opts.env, written: [] as Uint8Array[], sizes: [[opts.cols, opts.rows]] as [number, number][], killed: false, emit: onData };
    spawns.push(rec);
    const h: PtyHandle = { write: (b) => rec.written.push(b), resize: (c, r) => rec.sizes.push([c, r]), kill: () => (rec.killed = true) };
    return h;
  };
  const logs: string[] = [];
  const cli = generateKeyPair();
  const bridge = new TerminalBridge({ session: "burrow-ledger-ab12cd34", channel, spawn, env: { TMUX: "/tmp/x,1,0", PATH: "/usr/bin" }, folder: async () => "/work/example", log: (l) => logs.push(l), keyPair: () => cli });
  const browser = generateKeyPair();
  const sid = "sess-1";
  const keys = deriveKeys("browser", browser.privateKey, cli.publicKey, sid);
  const browserSend = new Sender(keys.send, DIR_BROWSER_TO_CLI);
  const browserRecv = new Receiver(keys.recv, DIR_CLI_TO_BROWSER);
  const emit = (e: string, p: Record<string, unknown> = {}) => handlers.get(e)?.(p);
  const openAndHello = async () => {
    emit("open", { session_id: sid });
    emit("hello", { pub: toB64(browser.publicKey) });
    await Bun.sleep(0);
  };
  return { bridge, emit, binary, pushed, out, spawns, logs, browserSend, browserRecv, openAndHello, drop: () => dropFn() };
}

describe("terminal bridge", () => {
  test("nothing is opened until core sends open", () => {
    const r = rig();
    expect(r.spawns).toHaveLength(0);
    r.emit("hello", { pub: toB64(generateKeyPair().publicKey) });
    expect(r.spawns).toHaveLength(0);
  });

  test("open sends hello; the handshake then attaches read-only and sends the folder encrypted", async () => {
    const r = rig();
    await r.openAndHello();
    expect(r.pushed[0]?.event).toBe("hello");
    expect(r.spawns).toHaveLength(1);
    const argv = r.spawns[0]?.argv ?? [];
    expect(argv).toContain("-r");
    expect(argv).toEqual(attachClientArgv("burrow-ledger-ab12cd34", false));
    expect(r.spawns[0]?.env.TMUX).toBeUndefined();
    const first = r.browserRecv.open(r.out[0] ?? new Uint8Array());
    expect(first?.kind).toBe(KIND_CONTROL);
    expect(JSON.parse(new TextDecoder().decode(first?.body))).toEqual({ cwd: "/work/example" });
    // The folder is not in plaintext anywhere on the wire.
    expect(Buffer.from(r.out[0] ?? []).includes("/work/example")).toBe(false);
  });

  test("pty output is forwarded verbatim, encrypted", async () => {
    const r = rig();
    await r.openAndHello();
    r.spawns[0]?.emit(text("hi \u001b[31mthere\r\n"));
    const f = r.browserRecv.open(r.out[1] ?? new Uint8Array());
    expect(f?.kind).toBe(KIND_DATA);
    expect(new TextDecoder().decode(f?.body)).toBe("hi \u001b[31mthere\r\n");
  });

  test("in is dropped while ro and delivered after mode rw", async () => {
    const r = rig();
    await r.openAndHello();
    r.binary.get("in")?.(r.browserSend.seal(KIND_DATA, text("ls\r")));
    expect(r.spawns[0]?.written).toHaveLength(0);
    r.emit("mode", { mode: "rw" });
    expect(r.spawns[0]?.killed).toBe(true); // our own client, replaced
    expect(r.spawns).toHaveLength(2);
    expect(r.spawns[1]?.argv).not.toContain("-r");
    r.binary.get("in")?.(r.browserSend.seal(KIND_DATA, text("ls\r")));
    expect(r.spawns[1]?.written.map((b) => new TextDecoder().decode(b))).toEqual(["ls\r"]);
  });

  test("a replayed in frame is not written twice", async () => {
    const r = rig();
    await r.openAndHello();
    r.emit("mode", { mode: "rw" });
    const frame = r.browserSend.seal(KIND_DATA, text("x"));
    r.binary.get("in")?.(frame);
    r.binary.get("in")?.(frame);
    expect(r.spawns[1]?.written).toHaveLength(1);
  });

  test("every new open starts read-only again", async () => {
    const r = rig();
    await r.openAndHello();
    r.emit("mode", { mode: "rw" });
    expect(r.bridge.mode).toBe("rw");
    r.emit("open", { session_id: "sess-2" });
    expect(r.bridge.mode).toBe("ro");
  });

  test("resize reaches the pty; junk sizes do not", async () => {
    const r = rig();
    await r.openAndHello();
    r.emit("resize", { cols: 120, rows: 40 });
    r.emit("resize", { cols: -1, rows: "x" });
    expect(r.spawns[0]?.sizes).toEqual([[80, 24], [120, 40]]);
  });

  test("detach and a socket drop kill only the bridge's own client", async () => {
    const r = rig();
    await r.openAndHello();
    r.emit("detach");
    expect(r.spawns[0]?.killed).toBe(true);
    expect(r.bridge.active).toBe(false);
    const r2 = rig();
    await r2.openAndHello();
    r2.drop();
    expect(r2.spawns[0]?.killed).toBe(true);
    for (const s of [...r.spawns, ...r2.spawns]) expect(s.argv.some((a) => /kill-(session|server)/.test(a))).toBe(false);
  });

  test("no spawned argv ever contains kill-session or kill-server", async () => {
    const r = rig();
    await r.openAndHello();
    r.emit("mode", { mode: "rw" });
    r.emit("mode", { mode: "ro" });
    r.emit("detach");
    expect(r.spawns.length).toBeGreaterThan(2);
    expect(r.spawns.flatMap((s) => s.argv).some((a) => /kill-(session|server)/.test(a))).toBe(false);
  });

  test("logs carry event names and sizes, never payloads", async () => {
    const r = rig();
    await r.openAndHello();
    const canary = "CANARY-7f3a-secret";
    r.spawns[0]?.emit(text(`${canary}\r\n`));
    r.emit("mode", { mode: "rw" });
    r.binary.get("in")?.(r.browserSend.seal(KIND_DATA, text(canary)));
    r.emit("detach");
    const all = r.logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(canary);
    expect(all).not.toContain(toB64(text(canary)));
    expect(all).toMatch(/out \d+/);
  });
});

describe("encoded key helpers", () => {
  test("base64 round trips", () => {
    const k = generateKeyPair().publicKey;
    expect(toHex(fromB64(toB64(k)))).toBe(toHex(k));
  });
});

describe("live pty", () => {
  test("a real pty echoes, resizes and is killed by its handle", async () => {
    const chunks: string[] = [];
    let exited: number | null | undefined;
    const h = livePty(["cat"], { cols: 80, rows: 24, env: { PATH: process.env.PATH ?? "" } }, (b) => chunks.push(new TextDecoder().decode(b)), (c) => (exited = c));
    h.write(text("ping\n"));
    for (let i = 0; i < 50 && !chunks.join("").includes("ping"); i++) await Bun.sleep(20);
    expect(chunks.join("")).toContain("ping");
    h.resize(100, 30);
    h.kill();
    for (let i = 0; i < 50 && exited === undefined; i++) await Bun.sleep(20);
    expect(exited).not.toBeUndefined();
  });
});

describe("permission: federation kind x opt-in", () => {
  test("the only enableable kind is the owner's own agent, and it still needs the opt-in", () => {
    expect(ENABLEABLE_KINDS).toEqual([FEDERATION_OWN_AGENT]);
    expect(remoteTerminalPermission(FEDERATION_OWN_AGENT, true)).toEqual({ enabled: true });
    expect(remoteTerminalPermission(FEDERATION_OWN_AGENT, false).enabled).toBe(false);
  });

  test("a non-owner kind can't be switched on, opted in or not", () => {
    for (const kind of ["guest_agent", "agent_in_foreign_install", "shared_runtime", "", "OWN_AGENT_IN_MEMBER_INSTALL"]) {
      expect(remoteTerminalPermission(kind, true).enabled).toBe(false);
      expect(remoteTerminalPermission(kind, false).enabled).toBe(false);
    }
  });

  test("one list: the config host and the terminal read the same ENABLEABLE_KINDS", () => {
    expect(ENABLEABLE_KINDS).toBe(HOST_ENABLEABLE_KINDS);
  });

  test("a non-owner kind cannot be switched on: nothing is recorded, with no override", () => {
    const f = connectedFolder();
    const res = setRemoteTerminal(f.env, f.agent, "burrow-x", "guest_agent");
    expect(res.ok).toBe(false);
    expect(remoteTerminalOf(readAgentRecordExact(f.env, f.agent)!.record)).toBeNull();
    expect(setRemoteTerminal(f.env, f.agent, "burrow-x").ok).toBe(true);
    expect(setRemoteTerminal(f.env, f.agent, null, "guest_agent").ok).toBe(true); // off is never refused
    expect(remoteTerminalOf(readAgentRecordExact(f.env, f.agent)!.record)).toBeNull();
  });

  test("launching in an unconnected folder says so and records nothing", () => {
    const home = mkdtempSync(resolve(tmpdir(), "rt-home-"));
    homes.push(home);
    mkdirSync(resolve(home, "bare"));
    const note = launchRemoteTerminal({ HOME: home }, resolve(home, "bare"), "s", true);
    expect(note).toContain("not connected");
  });
});

/* ---------------------------------------- on the folder's shared host socket */

/** A client binary push: kind 0, then the sizes of join ref, ref, topic and event. */
function decodeClientPush(d: Uint8Array): { topic: string; event: string; payload: Uint8Array } {
  const dec = new TextDecoder();
  const [jr, r, t, e] = [d[1] ?? 0, d[2] ?? 0, d[3] ?? 0, d[4] ?? 0];
  const topic = dec.decode(d.subarray(5 + jr + r, 5 + jr + r + t));
  const event = dec.decode(d.subarray(5 + jr + r + t, 5 + jr + r + t + e));
  return { topic, event, payload: d.slice(5 + jr + r + t + e) };
}

class FakeBinarySocket implements SocketLike {
  readyState = 0;
  frames: (string | Uint8Array)[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array): void {
    this.frames.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  get json(): unknown[][] {
    return this.frames.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f) as unknown[]);
  }
  get binary(): Uint8Array[] {
    return this.frames.filter((f): f is Uint8Array => typeof f !== "string");
  }
  json_(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  bin(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

describe("the terminal rides the folder's ONE shared socket", () => {
  function host(opts: { access?: "owner_only" | "admins"; terminal?: string } = {}) {
    const f = connectedFolder();
    if (opts.access !== undefined) setConfigAccess(f.env, f.agent, opts.access);
    if (opts.terminal !== undefined) setRemoteTerminal(f.env, f.agent, opts.terminal);
    const sockets: FakeBinarySocket[] = [];
    const spawns: { argv: string[]; written: Uint8Array[]; killed: boolean; emit(b: Uint8Array): void }[] = [];
    const tmuxRan: string[][] = [];
    let alive = true;
    const mgr = new HostManager({
      env: f.env,
      socket: (url) => {
        const s = new FakeBinarySocket(url);
        sockets.push(s);
        return s;
      },
      log: () => {},
      harnessFor: () => "claude_code",
      codexHomeFor: () => null,
      setTimer: () => 0,
      clearTimer: () => {},
      terminal: {
        spawn: (argv, _o, onData) => {
          const rec = { argv, written: [] as Uint8Array[], killed: false, emit: onData };
          spawns.push(rec);
          return { write: (b) => rec.written.push(b), resize: () => {}, kill: () => (rec.killed = true) };
        },
        tmux: async (argv) => {
          tmuxRan.push(argv);
          if (argv.includes("has-session")) return { exitCode: alive ? 0 : 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "/work/example\n", stderr: "" };
        },
      },
    });
    return { ...f, mgr, sockets, spawns, tmuxRan, setAlive: (v: boolean) => (alive = v) };
  }
  const joins = (s: FakeBinarySocket) => s.json.filter((f) => f[3] === "phx_join").map((f) => f[2]);

  test("opt-in on, config access off: one socket, joined on terminal:<id> only", () => {
    const h = host({ terminal: "burrow-ledger-ab12cd34" });
    h.mgr.sync();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.open();
    expect(joins(h.sockets[0]!)).toEqual(["terminal:rt-a-00000000"]);
    expect(h.mgr.terminalFolders()).toEqual([h.agent]);
  });

  test("both features on: still ONE socket, two topics, never runtime:<id>", () => {
    const h = host({ access: "admins", terminal: "burrow-ledger-ab12cd34" });
    h.mgr.sync();
    h.mgr.sync();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.open();
    expect(joins(h.sockets[0]!).sort()).toEqual(["runtime_host:rt-a-00000000", "terminal:rt-a-00000000"]);
    expect(joins(h.sockets[0]!)).not.toContain("runtime:rt-a-00000000");
  });

  test("no opt-in: no terminal topic and nothing attached", () => {
    const h = host({ access: "admins" });
    h.mgr.sync();
    h.sockets[0]!.open();
    expect(joins(h.sockets[0]!)).toEqual(["runtime_host:rt-a-00000000"]);
    expect(h.mgr.terminalFolders()).toEqual([]);
    const none = host();
    none.mgr.sync();
    expect(none.sockets).toHaveLength(0);
  });

  test("an open starts read-only over the shared socket, the sealed folder goes out as a binary push, and in is dropped until rw", async () => {
    const h = host({ terminal: "burrow-ledger-ab12cd34" });
    h.mgr.sync();
    const s = h.sockets[0]!;
    s.open();
    const join = s.json.find((f) => f[3] === "phx_join")!;
    s.json_([join[0], join[1], join[2], "phx_reply", { status: "ok", response: {} }]);

    const browser = generateKeyPair();
    s.json_([null, null, "terminal:rt-a-00000000", "open", { session_id: "sess-1" }]);
    const hello = s.json.find((f) => f[3] === "hello")!;
    const cliPub = fromB64((hello[4] as { pub: string }).pub);
    s.json_([null, null, "terminal:rt-a-00000000", "hello", { pub: toB64(browser.publicKey) }]);
    await Bun.sleep(5);

    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.argv).toContain("-r");
    const keys = deriveKeys("browser", browser.privateKey, cliPub, "sess-1");
    const recv = new Receiver(keys.recv, DIR_CLI_TO_BROWSER);
    const first = decodeClientPush(s.binary[0]!);
    expect(first).toMatchObject({ topic: "terminal:rt-a-00000000", event: "out" });
    const rec0 = recv.open(first.payload)!;
    expect(rec0.kind).toBe(KIND_CONTROL);
    expect(JSON.parse(new TextDecoder().decode(rec0.body))).toEqual({ cwd: "/work/example" });

    // pty output is forwarded verbatim and sealed
    h.spawns[0]!.emit(text("hello"));
    const second = decodeClientPush(s.binary[1]!);
    expect(new TextDecoder().decode(recv.open(second.payload)!.body)).toBe("hello");

    // in is dropped while ro, delivered after mode rw (a binary server push on the shared socket)
    const send = new Sender(keys.send, DIR_BROWSER_TO_CLI);
    const inFrame = (t: string) => {
      const payload = send.seal(KIND_DATA, text(t));
      const topic = "terminal:rt-a-00000000";
      const enc = new TextEncoder();
      const parts = ["", topic, "in"].map((x) => enc.encode(x));
      const out = new Uint8Array(4 + parts.reduce((n, p) => n + p.length, 0) + payload.length);
      out.set([0, parts[0]!.length, parts[1]!.length, parts[2]!.length], 0);
      let at = 4;
      for (const p of [...parts, payload]) (out.set(p, at), (at += p.length));
      return out;
    };
    s.bin(inFrame("ls\r"));
    expect(h.spawns[0]!.written).toHaveLength(0);
    s.json_([null, null, "terminal:rt-a-00000000", "mode", { mode: "rw" }]);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.argv).not.toContain("-r");
    s.bin(inFrame("pwd\r"));
    expect(new TextDecoder().decode(h.spawns[1]!.written[0]!)).toBe("pwd\r");
  });

  test("when the agent session ends, the terminal detaches and the opt-in is cleared; no argv kills a session", async () => {
    const h = host({ terminal: "burrow-ledger-ab12cd34" });
    h.mgr.sync();
    h.sockets[0]!.open();
    h.setAlive(false);
    h.mgr.sync();
    await Bun.sleep(5);
    expect(h.mgr.terminalFolders()).toEqual([]);
    expect(remoteTerminalOf(readAgentRecordExact(h.env, h.agent)!.record)).toBeNull();
    expect(h.tmuxRan.flat().some((a) => /kill-(session|server)/.test(a))).toBe(false);
    expect(h.spawns.every((x) => !x.argv.some((a) => /kill-(session|server)/.test(a)))).toBe(true);
  });

  test("binary frames for another topic or event are ignored, and JSON topics are unaffected", () => {
    const h = host({ access: "admins", terminal: "burrow-ledger-ab12cd34" });
    h.mgr.sync();
    const s = h.sockets[0]!;
    s.open();
    s.bin(new Uint8Array([0, 0, 5, 2, ...new TextEncoder().encode("nope"), ...new TextEncoder().encode("xx"), 9]));
    s.bin(new Uint8Array([9, 9, 9]));
    expect(h.spawns).toHaveLength(0);
  });

  test("HostSocket: a topic can be left without taking the socket or its other topics down", () => {
    const sock = new HostSocket({ url: "ws://x/websocket", socket: (u) => new FakeBinarySocket(u), log: () => {}, setTimer: () => 0, clearTimer: () => {} });
    const a = sock.topic("a", () => ({}));
    sock.topic("b", () => ({}));
    sock.connect();
    expect(a.isJoined()).toBe(false);
    sock.leaveTopic("a");
    expect(() => sock.topic("a", () => ({}))).not.toThrow();
  });
});
