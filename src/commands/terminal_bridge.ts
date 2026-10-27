/**
 * `burrow terminal-bridge --session NAME` — the process `burrow claude
 * --remote-terminal` starts in its own tmux session.
 *
 * It opens ONE outbound connection to the install's runtime socket and joins
 * `terminal:<runtime id>`. It does not join `runtime:<id>` (that join tracks
 * presence and drains queues, and belongs to the channel plugin). No inbound
 * port is opened. Everything it does is in src/terminal/bridge.ts.
 */
import { agentConfig, readAgentConnection } from "../agent_connections.ts";
import { TOKEN_KEY } from "../secrets.ts";
import { hasConnection } from "../connection.ts";
import { PhoenixChannel, socketUrl, type SocketLike } from "../codex/phoenix.ts";
import { TMUX, hasSessionArgv, newSessionArgv, terminalBridgeSessionName, type TmuxDeps } from "../tmux.ts";
import { channelWsUrl } from "./init.ts";
import { loadCredentials, selfArgv, type DeepseekDeps } from "./deepseek.ts";
import { THIS_CLI_KIND, remoteTerminalPermission } from "../terminal/permission.ts";
import { VERSION, CLI_NAME } from "../version.ts";
import { livePty } from "../terminal/pty.ts";
import { TerminalBridge } from "../terminal/bridge.ts";

export interface BridgeArgs {
  session?: string;
  root?: string;
  federationKind?: string;
}

export function parseBridgeArgs(args: string[]): BridgeArgs {
  const out: BridgeArgs = {};
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--session" && next !== undefined) out.session = next;
    if (args[i] === "--root" && next !== undefined) out.root = next;
    if (args[i] === "--federation-kind" && next !== undefined) out.federationKind = next;
  }
  return out;
}

/**
 * Start the bridge in its own tmux session, unless one is already there.
 * Returns a one-line note for the operator.
 */
export async function startBridgeSession(
  tmux: TmuxDeps,
  input: { session: string; cwd: string; env: Record<string, string | undefined>; kind?: string },
): Promise<string> {
  const allowed = remoteTerminalPermission(input.kind ?? THIS_CLI_KIND, true);
  if (!allowed.enabled) return `remote terminal: refused: ${allowed.reason}`;
  const name = terminalBridgeSessionName(input.session);
  const has = await tmux.run(hasSessionArgv(name));
  if (has.exitCode === 0) return `remote terminal: bridge ${name} already running`;
  const command = [...selfArgv(input.env as NodeJS.ProcessEnv), "terminal-bridge", "--session", input.session, "--root", input.cwd];
  const made = await tmux.run(newSessionArgv({ session: name, cwd: input.cwd, command }));
  if (made.exitCode !== 0) return `remote terminal: could not start the bridge: ${made.stderr.trim()}`;
  return `remote terminal: bridge ${name} started (read-only until switched; a read-write terminal is a shell as you)`;
}

export async function runTerminalBridge(args: string[], env: Record<string, string | undefined>, tmux: TmuxDeps, cwd: string): Promise<number> {
  const opts = parseBridgeArgs(args);
  const log = (line: string) => process.stderr.write(`${CLI_NAME} terminal-bridge: ${line}\n`);
  if (opts.session === undefined || opts.session === "") {
    log("--session NAME is required");
    return 2;
  }
  const session = opts.session;
  const allowed = remoteTerminalPermission(opts.federationKind ?? THIS_CLI_KIND, true);
  if (!allowed.enabled) {
    log(`refused: ${allowed.reason}`);
    return 2;
  }
  const root = opts.root ?? cwd;
  const found = readAgentConnection(env, root).connection;
  const config = found === null ? null : agentConfig(env, found.record);
  if (config === null || !hasConnection(config)) {
    log(`${root} is not connected; run \`${CLI_NAME} init --dir ${root}\``);
    return 1;
  }
  const token = (await loadCredentials(config, {} as DeepseekDeps, found?.record.dir ?? root, env))[TOKEN_KEY];
  if (token === undefined) {
    log(`no runtime token found; run \`${CLI_NAME} init\``);
    return 1;
  }

  const channel = new PhoenixChannel({
    url: socketUrl(channelWsUrl(config.suiteUrl), { runtime_id: config.runtimeId, token }),
    topic: `terminal:${config.runtimeId}`,
    joinPayload: { client_info: { product: "burrow_terminal_bridge", version: VERSION } },
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    log,
  });
  const bridge = new TerminalBridge({
    session,
    channel,
    spawn: livePty,
    env,
    log,
    folder: async () => {
      const r = await tmux.run([TMUX, "display-message", "-p", "-t", session, "#{pane_current_path}"]);
      return r.exitCode === 0 ? r.stdout.trim() : "";
    },
  });
  channel.connect();

  // The bridge serves one agent session; when that session is gone it stops.
  return await new Promise<number>((resolve) => {
    const stop = (code: number) => {
      bridge.end("stop");
      channel.stop();
      resolve(code);
    };
    process.on("SIGTERM", () => stop(0));
    process.on("SIGINT", () => stop(0));
    const timer = setInterval(async () => {
      const has = await tmux.run(hasSessionArgv(session));
      if (has.exitCode !== 0) {
        clearInterval(timer);
        log("agent session is gone; stopping");
        stop(0);
      }
    }, 30_000);
  });
}
