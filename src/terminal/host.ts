/**
 * The remote terminal, hosted inside `burrow watch` on the folder's shared
 * socket (task 01a17b17).
 *
 * `burrow claude --remote-terminal` records the opt-in on the agent folder's
 * record (`remoteTerminal` = the agent session name). `burrow watch` already
 * holds ONE outbound socket per folder for the config host; this attaches
 * `terminal:<runtime id>` to it (never `runtime:<id>`, never a second socket)
 * and runs the bridge in-process. No inbound port is opened.
 *
 * Off by default and per launch: the marker is cleared when the agent session
 * ends and by the next launch that has no flag. A kind outside
 * ENABLEABLE_KINDS cannot be switched on, opted in or not.
 */
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { agentConfigPath, canonicalDir, readAgentConnection, readAgentRecordExact, serializeAgentRecord, type AgentRecord } from "../agent_connections.ts";
import { TMUX, hasSessionArgv } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { TerminalBridge, type BridgeChannel } from "./bridge.ts";
import { remoteTerminalPermission } from "./permission.ts";
import type { SpawnPty } from "./pty.ts";
import type { HostSocket } from "../host/socket.ts";
import { connectionKind } from "../host/access.ts";

type Env = Record<string, string | undefined>;

export interface TerminalDeps {
  spawn: SpawnPty;
  /** Runs a tmux command. */
  tmux(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function remoteTerminalOf(record: AgentRecord): string | null {
  return typeof record.remoteTerminal === "string" && record.remoteTerminal !== "" ? record.remoteTerminal : null;
}

export type TerminalSetResult = { ok: true } | { ok: false; reason: string };

/**
 * Switch the terminal on for `session` (or off with null). On is refused for a
 * kind outside the enableable list; off never is.
 */
export function setRemoteTerminal(env: Env, dir: string, session: string | null, kind?: string): TerminalSetResult {
  const found = readAgentRecordExact(env, canonicalDir(dir));
  if (found === null) return { ok: false, reason: `${dir} is not a connected agent folder (run \`burrow init\` there first)` };
  if (session !== null) {
    const allowed = remoteTerminalPermission(kind ?? connectionKind(found.record), true);
    if (!allowed.enabled) return { ok: false, reason: allowed.reason };
  }
  if ((remoteTerminalOf(found.record) ?? null) === session) return { ok: true };
  const next: AgentRecord = { ...found.record };
  if (session === null) delete next.remoteTerminal;
  else next.remoteTerminal = session;
  const path = agentConfigPath(env, found.record.dir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeAgentRecord(next), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { ok: true };
}

export interface TerminalAttachment {
  readonly session: string;
  readonly sock: HostSocket;
  /** Ends the bridge's own tmux client and leaves the topic. The agent's session is never touched. */
  end(): void;
}

/** Attach the terminal topic to a folder's shared socket. */
export function attachTerminal(
  sock: HostSocket,
  o: { runtimeId: string; session: string; env: Env; deps: TerminalDeps; log(line: string): void },
): TerminalAttachment {
  const name = `terminal:${o.runtimeId}`;
  const topic = sock.topic(name, () => ({ client_info: { product: "burrow_terminal_bridge", version: VERSION } }));
  const channel: BridgeChannel = {
    on: (event, fn) => topic.on(event, fn),
    onBinary: (event, fn) => topic.onBinary(event, fn),
    onDropped: (fn) => topic.onDropped(fn),
    push: async (event, payload) => {
      topic.push(event, payload);
    },
    pushBinary: (event, bytes) => topic.pushBinary(event, bytes),
  };
  const bridge = new TerminalBridge({
    session: o.session,
    channel,
    spawn: o.deps.spawn,
    env: o.env,
    log: o.log,
    folder: async () => {
      const r = await o.deps.tmux([TMUX, "display-message", "-p", "-t", o.session, "#{pane_current_path}"]);
      return r.exitCode === 0 ? r.stdout.trim() : "";
    },
  });
  return {
    session: o.session,
    sock,
    end: () => {
      bridge.end("detach");
      sock.leaveTopic(name);
    },
  };
}

/** Is the agent session still there? */
export async function sessionAlive(deps: TerminalDeps, session: string): Promise<boolean> {
  return (await deps.tmux(hasSessionArgv(session, TMUX))).exitCode === 0;
}

/**
 * What `burrow claude` does about the terminal at launch. Returns a one-line
 * note for the operator, or null when there is nothing to say.
 *
 * Without the flag a stale marker from an earlier launch is cleared: the opt-in
 * is per launch.
 */
export function launchRemoteTerminal(env: Env, cwd: string, session: string, enabled: boolean): string | null {
  try {
    const found = readAgentConnection(env, cwd).connection;
    if (!enabled) {
      if (found !== null && remoteTerminalOf(found.record) !== null) setRemoteTerminal(env, found.record.dir, null);
      return null;
    }
    if (found === null) return `remote terminal: ${cwd} is not connected; run \`burrow init\` first`;
    const res = setRemoteTerminal(env, found.record.dir, session);
    if (!res.ok) return `remote terminal: refused: ${res.reason}`;
    return `remote terminal: on for ${session}. \`burrow watch\` serves it on its next pass (read-only until switched; a read-write terminal is a shell as you)`;
  } catch (err) {
    // A launch must never fail because the opt-in could not be read or written.
    return enabled ? `remote terminal: could not record the opt-in: ${(err as Error).message}` : null;
  }
}
