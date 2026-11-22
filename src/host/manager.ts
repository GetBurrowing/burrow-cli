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
 * The runtime token comes from the folder's credentials file, its `tokenEnv`,
 * or its `tokenRef` (a stamped root's identity names its token only by
 * reference). A `file:` ref is read on each pass; a `keychain:` ref is
 * resolved once in the background and the pass is run again. A folder with a
 * feature on and no token is said once, not skipped silently.
 *
 * When the agent session the terminal serves is gone, the terminal detaches.
 * The opt-in is cleared too, UNLESS the launch that recorded the session asked
 * for the terminal (`keepTerminal`, the roster's `remoteTerminal`): then it
 * stays on, and the terminal re-attaches when the session is back after a
 * restart, a reboot or `burrow restore`.
 *
 * `sync()` is called once per watch pass; it opens what is newly enabled,
 * replaces a connection whose URL or access changed, and closes what is
 * switched off. Reconnect with backoff lives in {@link HostSocket}.
 */
import { channelWsUrl } from "../commands/init.ts";
import { socketUrl, type Payload, type SocketFactory } from "../codex/phoenix.ts";
import { listAgentConnections, readAgentSecrets, type AgentConnection } from "../agent_connections.ts";
import { parseTokenRef, resolveFileTokenRef, resolveTokenRef, type TokenRef } from "../token_ref.ts";
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
  /**
   * Did the launch that recorded `session` in `dir` ask for the remote
   * terminal? Then its end does not clear the opt-in. Absent: never.
   */
  keepTerminal?(dir: string, session: string): boolean;
  /** Resolves a `keychain:` ref. Defaults to {@link resolveTokenRef}. */
  resolveRef?(ref: TokenRef): Promise<string>;
}

type TokenLookup = { token: string } | { pending: true } | { error: string };

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
  /** Folders whose kept-on terminal is waiting for its agent session to come back. */
  private readonly dormant = new Set<string>();
  /** keychain ref -> its value or its in-flight resolution, so `security` is not run each pass. */
  private readonly keychain = new Map<string, { token: string } | { pending: true }>();
  /** The dir -> the last "no token" line said for it, so it is said once. */
  private readonly saidNoToken = new Map<string, string>();

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
      const found = this.tokenOf(conn);
      if ("pending" in found) {
        // Keep what is open until the ref resolves; the pass is run again then.
        if (this.live.has(dir)) seen.add(dir);
        continue;
      }
      if ("error" in found) {
        if (this.saidNoToken.get(dir) !== found.error) {
          this.saidNoToken.set(dir, found.error);
          this.deps.log(`host ${conn.record.runtimeId}: no runtime token for ${dir} (${found.error}); not connected`);
        }
        continue;
      }
      this.saidNoToken.delete(dir);
      const token = found.token;
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
    for (const dir of [...this.dormant]) if (!wanted.has(dir)) this.dormant.delete(dir);
    for (const [dir, want] of wanted) {
      const sock = this.live.get(dir)?.sock;
      if (sock === undefined) continue;
      const have = this.terminals.get(dir);
      if (have === undefined) {
        if (!this.dormant.has(dir)) {
          this.attach(dir, sock, want, terminal);
          continue;
        }
        // Kept on across a restart: attach again once the agent session is back.
        void sessionAlive(terminal, want.session).then((alive) => {
          if (!alive || !this.dormant.has(dir) || this.terminals.has(dir) || this.live.get(dir)?.sock !== sock) return;
          this.dormant.delete(dir);
          this.attach(dir, sock, want, terminal);
        });
        continue;
      }
      // The terminal serves one agent session. When it is gone the terminal
      // detaches; the opt-in ends with it unless the launch asked to keep it.
      void sessionAlive(terminal, have.session).then((alive) => {
        if (alive || this.terminals.get(dir) !== have) return;
        this.endTerminal(dir);
        if (this.deps.keepTerminal?.(dir, have.session) === true) {
          this.dormant.add(dir);
          this.deps.log(`terminal ${want.runtimeId}: agent session is gone; detached, and kept on for when ${have.session} is back (it was launched with --remote-terminal)`);
          return;
        }
        setRemoteTerminal(this.deps.env, dir, null);
        this.deps.log(`terminal ${want.runtimeId}: agent session is gone; remote terminal off`);
      });
    }
  }

  private attach(dir: string, sock: HostSocket, want: { session: string; runtimeId: string }, terminal: TerminalDeps): void {
    const log = (line: string) => this.deps.log(`terminal ${want.runtimeId}: ${line}`);
    this.terminals.set(dir, attachTerminal(sock, { runtimeId: want.runtimeId, session: want.session, env: this.deps.env, deps: terminal, log }));
    this.deps.log(`terminal ${want.runtimeId}: attached for session ${want.session}`);
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

  /**
   * The folder's runtime token: its credentials file, then `tokenEnv`, then
   * `tokenRef`. Never logged; an error names the ref, never a value.
   */
  private tokenOf(conn: AgentConnection): TokenLookup {
    const stored = readAgentSecrets(this.deps.env, conn.record.dir)?.token;
    if (stored !== undefined && stored !== "") return { token: stored };
    if (conn.record.tokenEnv !== undefined) {
      const fromEnv = this.deps.env[conn.record.tokenEnv];
      if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv };
      if (conn.record.tokenRef === undefined) return { error: `${conn.record.tokenEnv} is not set in watch's environment` };
    }
    if (conn.record.tokenRef === undefined) return { error: "no credentials file, tokenEnv or tokenRef" };
    let ref: TokenRef;
    try {
      ref = parseTokenRef(conn.record.tokenRef, conn.record.keychainService !== undefined ? { keychainService: conn.record.keychainService } : {});
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (ref.kind === "file") {
      try {
        return { token: resolveFileTokenRef(ref.path) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    const key = `${ref.service}\0${ref.item}`;
    const cached = this.keychain.get(key);
    if (cached !== undefined) return cached;
    this.keychain.set(key, { pending: true });
    void (this.deps.resolveRef ?? resolveTokenRef)(ref).then(
      (token) => {
        this.keychain.set(key, { token });
        this.sync();
      },
      (e: Error) => {
        // Forgotten, so a later pass asks the keychain again (it may be unlocked by then).
        this.keychain.delete(key);
        if (this.saidNoToken.get(conn.record.dir) === e.message) return;
        this.saidNoToken.set(conn.record.dir, e.message);
        this.deps.log(`host ${conn.record.runtimeId}: no runtime token for ${conn.record.dir} (${e.message}); not connected`);
      },
    );
    return { pending: true };
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
