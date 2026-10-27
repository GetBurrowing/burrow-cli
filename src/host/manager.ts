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
 * `sync()` is called once per watch pass; it opens what is newly enabled,
 * replaces a connection whose URL or access changed, and closes what is
 * switched off. Reconnect with backoff lives in {@link HostSocket}.
 */
import { channelWsUrl } from "../commands/init.ts";
import { socketUrl, type Payload, type SocketFactory } from "../codex/phoenix.ts";
import { listAgentConnections, readAgentSecrets, type AgentConnection } from "../agent_connections.ts";
import { VERSION } from "../version.ts";
import { accessOf, type ConfigAccess } from "./access.ts";
import { HostOps } from "./ops.ts";
import type { SessionOps } from "./session.ts";
import { HostSocket, type TopicHandle } from "./socket.ts";

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
}

interface Live {
  sock: HostSocket;
  topic: TopicHandle;
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
    capabilities: ["file", "session"],
    resumes: harness === "claude_code" || harness === "codex",
    config_opt_in: access,
  };
}

export class HostManager {
  private readonly live = new Map<string, Live>();
  /** The record dir -> the access the manager last read, so ops see a change at once. */
  private readonly access = new Map<string, ConfigAccess>();

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
    for (const conn of listAgentConnections(this.deps.env)) {
      const dir = conn.record.dir;
      const access = accessOf(conn.record);
      this.access.set(dir, access);
      if (access === "off") continue;
      const token = this.tokenOf(conn);
      if (token === null) continue;
      seen.add(dir);
      const url = socketUrl(channelWsUrl(conn.record.suiteUrl), { runtime_id: conn.record.runtimeId, token });
      const signature = `${url}|${access}`;
      const have = this.live.get(dir);
      if (have !== undefined && have.signature === signature) {
        void have.session?.observe();
        continue;
      }
      have?.sock.stop();
      this.open(conn, url, signature);
    }
    for (const [dir, l] of this.live) {
      if (!seen.has(dir)) {
        l.sock.stop();
        this.live.delete(dir);
        this.deps.log(`${dir}: config access off; host connection closed`);
      }
    }
  }

  stopAll(): void {
    for (const l of this.live.values()) l.sock.stop();
    this.live.clear();
  }

  private tokenOf(conn: AgentConnection): string | null {
    const stored = readAgentSecrets(this.deps.env, conn.record.dir)?.token;
    if (stored !== undefined && stored !== "") return stored;
    const fromEnv = conn.record.tokenEnv === undefined ? undefined : this.deps.env[conn.record.tokenEnv];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : null;
  }

  private open(conn: AgentConnection, url: string, signature: string): void {
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
    const ops = new HostOps({
      root: dir,
      ...(session !== null ? { session } : {}),
      access: () => this.access.get(dir) ?? "off",
      codexHome: () => this.deps.codexHomeFor(dir),
    });
    const topic = sock.topic(topicName(conn.record.runtimeId), () => helloFor(this.deps.harnessFor(dir), this.access.get(dir) ?? "off"));
    for (const event of ["file.list", "file.read", "file.write", "secret.set", "session.tools", "session.restart"]) {
      topic.on(event, (payload) => {
        const ref = payload["ref"];
        if (typeof ref !== "string") return;
        void ops.handle(event, payload).then((reply) => {
          if (reply === null) return; // access went off: say nothing
          topic.push("reply", { ref, ...reply });
        });
      });
    }
    this.live.set(dir, { sock, topic, signature, session });
    void session?.observe();
    sock.connect();
  }
}
