/**
 * LIVE SMOKE: the real `codex app-server`, driven by the real bridge, with an
 * EMPTY, throwaway CODEX_HOME — so no Codex login is used, and none can be.
 *
 * What this proves against the real binary, without a model turn:
 *
 *  - the handshake and JSON-RPC framing (initialize / initialized);
 *  - `account/read` reports no account — the precondition that this test
 *    touches nobody's login;
 *  - the `-c mcp_servers.*` overrides from `appServerArgv` parse, and Codex
 *    spawns `suite codex --reply-mcp` as the `burrow-channel` MCP server and
 *    lists its four tools;
 *  - `mcpServer/tool/call` on `burrow_reply` goes Codex → reply MCP server →
 *    unix socket → bridge → a `reply` push: the agent's reply path, end to end;
 *  - an attention becomes a real `thread/start` + `turn/start`, and the turn
 *    — which cannot run without a login — comes back failed and is reported in
 *    the space instead of vanishing;
 *  - a backlog of ten that built up during a turn goes out as ONE coalesced
 *    turn/start, which the real binary accepts, in arrival order.
 *
 * What it does NOT prove: a model actually answering. That needs a Codex
 * login, and the only one on the build host is not provisioned for this.
 * Skipped when `codex` is not on PATH (and says so).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerClient, processTransport, type Transport } from "../src/codex/app_server.ts";
import { CodexBridge } from "../src/codex/bridge.ts";
import type { Payload } from "../src/codex/phoenix.ts";
import { listenBridgeSocket } from "../src/codex/reply_mcp.ts";
import { appServerArgv, CHANNEL_MCP, codexEnv } from "../src/commands/codex.ts";
import { envValue } from "../src/env_names.ts";

const CODEX = Bun.which("codex");
// Real path: on macOS tmpdir() is under /var, a symlink to /private/var, and
// Codex reports its home resolved.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "suite-codex-live-")));
const HOME = join(ROOT, "codex-home");
const SPACE = "019f0000-0000-7000-8000-0000000000aa";
// Each case waits for its app-server to exit, so nothing is still writing
// under ROOT; the bound covers a slow disk removing two Codex homes.
afterAll(() => rmSync(ROOT, { recursive: true, force: true }), 30_000);

test("the live codex smoke test below is not silently skipped", () => {
  if (CODEX === null) console.warn("codex is not on PATH: the live app-server smoke test is skipped");
  expect(CODEX !== null || envValue(process.env, "CLI_ALLOW_NO_CODEX") === "1" || process.env.CI === "true").toBe(true);
});

describe.if(CODEX !== null)("real codex app-server, no login", () => {
  test(
    "handshake, MCP wiring, burrow_reply through Codex, and a turn that fails out loud",
    async () => {
      Bun.spawnSync(["mkdir", "-p", HOME]);
      const socketPath = join(ROOT, "b.sock");
      const argv = appServerArgv({
        codexBin: CODEX as string,
        // Nothing listens here: the tools server fails fast, which is fine —
        // this test is about the channel server and the protocol.
        suiteUrl: "http://127.0.0.1:9",
        headerNames: [],
        self: [process.execPath, resolve(import.meta.dir, "../src/cli.ts")],
        socketPath,
      });
      const proc = Bun.spawn(argv, { cwd: ROOT, env: codexEnv(process.env, HOME), stdin: "pipe", stdout: "pipe", stderr: "ignore" });

      const pushes: { event: string; payload: Payload }[] = [];
      const handlers = new Map<string, (p: Payload) => void>();
      const channel = {
        on: (e: string, fn: (p: Payload) => void) => void handlers.set(e, fn),
        push: async (event: string, payload: Payload) => {
          pushes.push({ event, payload });
          return { status: "ok", response: {} };
        },
      };
      let bridge: CodexBridge | null = null;
      const client = new AppServerClient(processTransport(proc), {
        onNotification: (m, p) => bridge?.onNotification(m, p),
        onRequest: (m, p) => (bridge as CodexBridge).answerServerRequest(m, p),
      });
      try {
        const init = await client.request<{ codexHome: string }>("initialize", {
          clientInfo: { name: "suite_codex_test", title: null, version: "0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        client.notify("initialized");
        expect(init.codexHome).toBe(HOME);

        const account = await client.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", {});
        expect(account.account).toBeNull();

        const logs: string[] = [];
        bridge = new CodexBridge(channel, client, {
          cwd: ROOT,
          approvals: "accept",
          sandbox: "danger-full-access",
          log: (l) => logs.push(l),
          loadThreads: () => ({}),
          saveThreads: () => {},
        });
        const b = bridge;
        const server = await listenBridgeSocket(socketPath, (tool, args) => b.channelTool(tool, args), () => {});

        // An attention: real thread/start + turn/start; without a login the
        // turn fails, and the bridge says so in the space.
        handlers.get("attention")?.({ signal: { reason: "mention", space_id: SPACE, message_id: "m1" }, message: { content: "ping", author: "Ryan" } });
        await Promise.race([b.whenIdle(), Bun.sleep(60_000)]);
        const threadLine = logs.find((l) => l.includes("started thread"));
        expect(threadLine).toBeDefined();
        expect(logs.some((l) => / turn \S+ failed$/.test(l))).toBe(true);
        const failure = pushes.find((p) => p.event === "reply");
        expect(String(failure?.payload.content)).toStartWith("I could not complete that turn");
        const threadId = /started thread (\S+)/.exec(threadLine as string)![1]!;

        // The channel server's tools, as Codex sees them.
        type Status = { data: { name: string; tools: Record<string, unknown> }[] };
        let status: Status = { data: [] };
        for (let i = 0; i < 40; i++) {
          status = await client.request<Status>("mcpServerStatus/list", { threadId, serverName: CHANNEL_MCP });
          if (Object.keys(status.data.find((s) => s.name === CHANNEL_MCP)?.tools ?? {}).length > 0) break;
          await Bun.sleep(250);
        }
        const tools = Object.keys(status.data.find((s) => s.name === CHANNEL_MCP)?.tools ?? {}).sort();
        expect(tools).toEqual([
          "burrow_reply",
          "burrow_reply_chunk",
          "burrow_reply_with_media",
          "burrow_typing",
          "suite_reply",
          "suite_reply_chunk",
          "suite_reply_with_media",
          "suite_typing",
        ]);

        // burrow_reply, called through Codex, lands as a reply push.
        pushes.length = 0;
        const r = await client.request<{ content: { text?: string }[]; isError?: boolean }>("mcpServer/tool/call", {
          threadId,
          server: CHANNEL_MCP,
          tool: "burrow_reply",
          arguments: { space_id: SPACE, content: "hello from codex" },
        });
        expect(r.isError ?? false).toBe(false);
        expect(r.content[0]?.text).toBe("reply sent");
        expect(pushes).toEqual([{ event: "reply", payload: { space_id: SPACE, content: "hello from codex" } }]);
        server.close();
      } finally {
        client.close();
        await Promise.race([proc.exited, Bun.sleep(10_000)]);
      }
    },
    120_000,
  );

  test(
    "a backlog that built up during a turn goes to the real binary as ONE coalesced turn/start",
    async () => {
      const home = join(ROOT, "codex-home-batch");
      Bun.spawnSync(["mkdir", "-p", home]);
      const argv = appServerArgv({
        codexBin: CODEX as string,
        suiteUrl: "http://127.0.0.1:9",
        headerNames: [],
        self: [process.execPath, resolve(import.meta.dir, "../src/cli.ts")],
        socketPath: join(ROOT, "batch.sock"),
      });
      const proc = Bun.spawn(argv, { cwd: ROOT, env: codexEnv(process.env, home), stdin: "pipe", stdout: "pipe", stderr: "ignore" });

      // Record every line both ways, so the turn/start requests and their
      // answers from the real binary can be read back.
      const inner = processTransport(proc);
      const sent: { id?: number; method?: string; params?: any }[] = [];
      const received: { id?: number; result?: unknown; error?: unknown }[] = [];
      const transport: Transport = {
        write: (line) => {
          sent.push(JSON.parse(line));
          inner.write(line);
        },
        onLine: (fn) =>
          inner.onLine((line) => {
            try {
              received.push(JSON.parse(line));
            } catch {}
            fn(line);
          }),
        onClose: (fn) => inner.onClose(fn),
        close: () => inner.close(),
      };

      const pushes: { event: string; payload: Payload }[] = [];
      const handlers = new Map<string, (p: Payload) => void>();
      const channel = {
        on: (e: string, fn: (p: Payload) => void) => void handlers.set(e, fn),
        push: async (event: string, payload: Payload) => {
          pushes.push({ event, payload });
          return { status: "ok", response: {} };
        },
      };
      let bridge: CodexBridge | null = null;
      const client = new AppServerClient(transport, {
        onNotification: (m, p) => bridge?.onNotification(m, p),
        onRequest: (m, p) => (bridge as CodexBridge).answerServerRequest(m, p),
      });
      try {
        const init = await client.request<{ codexHome: string }>("initialize", {
          clientInfo: { name: "suite_codex_test", title: null, version: "0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        client.notify("initialized");
        expect(init.codexHome).toBe(home);
        const account = await client.request<{ account: unknown }>("account/read", {});
        expect(account.account).toBeNull();

        const logs: string[] = [];
        bridge = new CodexBridge(channel, client, {
          cwd: ROOT,
          approvals: "accept",
          sandbox: "danger-full-access",
          log: (l) => logs.push(l),
          loadThreads: () => ({}),
          saveThreads: () => {},
        });
        const deliver = (i: number) =>
          handlers.get("attention")?.({ signal: { reason: "mention", space_id: SPACE, message_id: `b${i}` }, message: { content: `burst ${i}`, author: "Tester" } });
        // The first starts a turn; the next ten land synchronously, while it is
        // still in flight (the space is marked busy before the first await).
        deliver(0);
        for (let i = 1; i <= 10; i++) deliver(i);
        const idle = await Promise.race([bridge.whenIdle().then(() => true), Bun.sleep(90_000).then(() => false)]);
        expect(idle).toBe(true);

        const starts = sent.filter((m) => m.method === "turn/start");
        expect(starts.length).toBe(2);
        // The real binary accepted both: each turn/start got a result, no JSON-RPC error.
        for (const s of starts) {
          const answer = received.find((r) => r.id === s.id && (r.result !== undefined || r.error !== undefined));
          expect(answer?.error).toBeUndefined();
          expect(answer?.result).toBeDefined();
        }
        expect(logs.filter((l) => / turn \S+ started$/.test(l)).length).toBe(2);
        expect(logs.some((l) => l.includes("turn error"))).toBe(false);

        const text = starts[1]!.params.input[0].text as string;
        expect(starts[1]!.params.input.length).toBe(1);
        expect(text.startsWith("10 messages arrived in this space while your previous turn was running.")).toBe(true);
        const at = Array.from({ length: 10 }, (_, i) => text.indexOf(`\nburst ${i + 1}\n`));
        expect(at.every((x) => x >= 0)).toBe(true);
        expect([...at].sort((x, y) => x - y)).toEqual(at);
        expect(text).not.toContain("\nburst 0\n");

        // Each failed turn (no login) is reported in the space; nothing else is posted.
        const replies = pushes.filter((p) => p.event === "reply").map((p) => String(p.payload.content));
        expect(replies.length).toBe(2);
        for (const r of replies) expect(r).toStartWith("I could not complete that turn");
      } finally {
        client.close();
        await Promise.race([proc.exited, Bun.sleep(10_000)]);
      }
    },
    120_000,
  );
});
