/**
 * The host connections, inside `burrow watch`.
 *
 * `burrow watch` is the long-lived per-machine process and is installed by
 * default; the harness-held sockets die with the harness, this one does not,
 * so config files stay reachable while a session restarts.
 *
 * For every connected agent folder whose config access is not `off`, ONE
 * outbound socket to the runtime endpoint, joined on `runtime_host:<id>`, with
 * a hello. A folder with access `off` gets no socket at all: the host does not
 * join the topic, so there is nothing to refuse and no error op to return.
 *
 * The remote terminal (src/host/terminal.ts) attaches `terminal:<id>` to the
 * SAME socket when the folder's record carries a `remoteTerminal` marker, even
 * with config access off: a folder gets a socket when either feature wants one,
 * and each topic is registered only for the feature that is on.
 *
 * `sync()` is called once per watch pass; it opens what is newly enabled,
 * replaces a connection whose URL or access changed, and closes what is
 * switched off. Reconnect with backoff lives in {@link HostSocket}.
 */
import { channelWsUrl } from "../commands/init.ts";
import { socketUrl, type Payload, type SocketFactory } from "../codex/phoenix.ts";
import { listAgentConnections, readAgentSecrets, type AgentConnection } from "../agent_connections.ts";
import { VERSION } from "../version.ts";
import { accessOf, type ConfigAccess } from "./access.ts";
import { remoteTerminalPermission } from "../terminal/permission.ts";
import { HostOps } from "./ops.ts";
import type { SessionOps } from "./session.ts";
import { HostSocket, type TopicHandle } from "./socket.ts";
import { attachTerminal, remoteTerminalOf, sessionAlive, setRemoteTerminal, type TerminalAttachment, type TerminalDeps } from "../terminal/host.ts";
import { connectionKind } from "./access.ts";

type Env = Record<string, string | undefined>;

export interface HostDeps {
  env: Env;
  socket: SocketFactory;
  log(line: string): void;
  /** `claude_code` | `codex` | other harness kinds, for the hello. */
  harnessFor(dir: string): string;
  /** CODEX_HOME for this folder, null for the default `<root>/.codex`. */
  codexHomeFor(dir: string): string | null;
  /** session.* for this folder (stage 4); absent: those ops answer `unsupported`. */
  sessionFor?(dir: string): SessionOps | null;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** What the remote terminal needs (a pty and tmux). Absent: the terminal is never attached. */
  terminal?: TerminalDeps;
}

interface Live {
  sock: HostSocket;
  topic: TopicHandle | null;
  signature: string;
  session: SessionOps | null;
}

export function topicName(runtimeId: string): string {
  return `runtime_host:${runtimeId}`;
}

export function helloFor(harness: string, access: ConfigAccess): Payload {
  return {
    harness,
    cli_version: VERSION,
    capabilities: ["file", "session", "file.delete"],
    resumes: harness === "claude_code" || harness === "codex",
    config_opt_in: access,
  };
}

export class HostManager {
  private readonly live = new Map<string, Live>();
  /** The record dir -> the access the manager last read, so ops see a change at once. */
  private readonly access = new Map<string, ConfigAccess>();
  /** Folders with the remote terminal attached to their shared socket. */
  private readonly terminals = new Map<string, TerminalAttachment>();

  constructor(private readonly deps: HostDeps) {}

  /** Folders with an open host connection. */
  connected(): string[] {
    return [...this.live.keys()].sort();
  }

  /** The socket for a folder, so another topic (the terminal) can attach to it. */
  socketFor(dir: string): HostSocket | null {
    return this.live.get(dir)?.sock ?? null;
  }

  sync(): void {
    const seen = new Set<string>();
    const wanted = new Map<string, { session: string; runtimeId: string }>();
    for (const conn of listAgentConnections(this.deps.env)) {
      const dir = conn.record.dir;
      const access = accessOf(conn.record);
      this.access.set(dir, access);
      const session = this.deps.terminal === undefined ? null : remoteTerminalOf(conn.record);
      const terminalOn = session !== null && remoteTerminalPermission(connectionKind(conn.record), true).enabled;
      if (access === "off" && !terminalOn) continue;
      const token = this.tokenOf(conn);
      if (token === null) continue;
      seen.add(dir);
      if (terminalOn) wanted.set(dir, { session, runtimeId: conn.record.runtimeId });
      const url = socketUrl(channelWsUrl(conn.record.suiteUrl), { runtime_id: conn.record.runtimeId, token });
      const signature = `${url}|${access}`;
      const have = this.live.get(dir);
      if (have !== undefined && have.signature === signature) {
        void have.session?.observe();
        continue;
      }
      this.endTerminal(dir);
      have?.sock.stop();
      this.open(conn, url, signature, access);
    }
    for (const [dir, l] of this.live) {
      if (!seen.has(dir)) {
        this.endTerminal(dir);
        l.sock.stop();
        this.live.delete(dir);
        this.deps.log(`${dir}: no host feature is on; host connection closed`);
      }
    }
    this.syncTerminals(wanted);
  }

  /** Attach or detach the terminal topic on each folder's shared socket. */
  private syncTerminals(wanted: Map<string, { session: string; runtimeId: string }>): void {
    const terminal = this.deps.terminal;
    if (terminal === undefined) return;
    for (const dir of [...this.terminals.keys()]) {
      const want = wanted.get(dir);
      const have = this.terminals.get(dir)!;
      if (want === undefined || want.session !== have.session || this.live.get(dir)?.sock !== have.sock) this.endTerminal(dir);
    }
    for (const [dir, want] of wanted) {
      const sock = this.live.get(dir)?.sock;
      if (sock === undefined) continue;
      const have = this.terminals.get(dir);
      if (have === undefined) {
        const log = (line: string) => this.deps.log(`terminal ${want.runtimeId}: ${line}`);
        this.terminals.set(dir, attachTerminal(sock, { runtimeId: want.runtimeId, session: want.session, env: this.deps.env, deps: terminal, log }));
        this.deps.log(`terminal ${want.runtimeId}: attached for session ${want.session}`);
        continue;
      }
      // The terminal serves one agent session; when that session is gone the opt-in is over.
      void sessionAlive(terminal, have.session).then((alive) => {
        if (alive || this.terminals.get(dir) !== have) return;
        this.endTerminal(dir);
        setRemoteTerminal(this.deps.env, dir, null);
        this.deps.log(`terminal ${want.runtimeId}: agent session is gone; remote terminal off`);
      });
    }
  }

  private endTerminal(dir: string): void {
    const t = this.terminals.get(dir);
    if (t === undefined) return;
    this.terminals.delete(dir);
    t.end();
  }

  /** Folders with the remote terminal attached. */
  terminalFolders(): string[] {
    return [...this.terminals.keys()].sort();
  }

  stopAll(): void {
    for (const dir of [...this.terminals.keys()]) this.endTerminal(dir);
    for (const l of this.live.values()) l.sock.stop();
    this.live.clear();
  }

  private tokenOf(conn: AgentConnection): string | null {
    const stored = readAgentSecrets(this.deps.env, conn.record.dir)?.token;
    if (stored !== undefined && stored !== "") return stored;
    const fromEnv = conn.record.tokenEnv === undefined ? undefined : this.deps.env[conn.record.tokenEnv];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : null;
  }

  private open(conn: AgentConnection, url: string, signature: string, access: ConfigAccess): void {
    const dir = conn.record.dir;
    const log = (line: string) => this.deps.log(`host ${conn.record.runtimeId}: ${line}`);
    const sock = new HostSocket({
      url,
      socket: this.deps.socket,
      log,
      ...(this.deps.setTimer !== undefined ? { setTimer: this.deps.setTimer } : {}),
      ...(this.deps.clearTimer !== undefined ? { clearTimer: this.deps.clearTimer } : {}),
    });
    const session = this.deps.sessionFor?.(dir) ?? null;
    let topic: TopicHandle | null = null;
    if (access !== "off") {
      const ops = new HostOps({
        root: dir,
        ...(session !== null ? { session } : {}),
        access: () => this.access.get(dir) ?? "off",
        codexHome: () => this.deps.codexHomeFor(dir),
      });
      const t = sock.topic(topicName(conn.record.runtimeId), () => helloFor(this.deps.harnessFor(dir), this.access.get(dir) ?? "off"));
      for (const event of ["file.list", "file.read", "file.write", "secret.set", "session.tools", "session.restart"]) {
        t.on(event, (payload) => {
          const ref = payload["ref"];
          if (typeof ref !== "string") return;
          void ops.handle(event, payload).then((reply) => {
            if (reply === null) return; // access went off: say nothing
            t.push("reply", { ref, ...reply });
          });
        });
      }
      topic = t;
    }
    this.live.set(dir, { sock, topic, signature, session });
    void session?.observe();
    sock.connect();
  }
}
