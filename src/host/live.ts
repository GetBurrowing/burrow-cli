/** The real dependencies of {@link HostManager}: the roster and the WebSocket. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SocketLike } from "../codex/phoenix.ts";
import { parseRoster, rosterPath, type RosterEntry } from "../roster.ts";
import { canonicalDir } from "../agent_connections.ts";
import { liveTerminalDeps } from "../terminal/live.ts";
import type { HostDeps } from "./manager.ts";
import { stateEntry } from "../paths.ts";
import { liveRestartDeps, panePid, restartSession } from "../session_restart.ts";
import { SessionOps } from "./session.ts";
import { snapshotTools } from "./tools.ts";

type Env = Record<string, string | undefined>;

function rosterFor(env: Env, dir: string): RosterEntry | null {
  try {
    const entries = parseRoster(readFileSync(rosterPath(env.HOME ?? "", env), "utf8"));
    const canon = canonicalDir(dir);
    // The most recent launch in this folder (a `burrow claude new` beside it is a later one).
    const here = entries.filter((e) => canonicalDir(e.cwd) === canon);
    here.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
    return here.at(-1) ?? null;
  } catch {
    return null;
  }
}

const HARNESS: Record<RosterEntry["kind"], string> = {
  claude: "claude_code",
  codex: "codex",
  deepseek: "deepseek",
  hermes: "hermes",
  openclaw: "openclaw",
};

/**
 * The harness for the hello. A roster entry is the record of what was launched
 * here. Without one, say what the folder's own files show, and say `unknown`
 * when they show nothing: advertising `claude_code` for a Codex folder made core
 * read Claude's concepts (and write Claude's files) into it.
 */
export function harnessOf(entry: RosterEntry | null, dir?: string): string {
  if (entry !== null) return HARNESS[entry.kind];
  if (dir === undefined) return UNKNOWN_HARNESS;
  const has = (rel: string): boolean => existsSync(join(dir, rel));
  const claude = has("CLAUDE.md") || has(".claude");
  if (!claude && (has(".codex") || has("AGENTS.md"))) return "codex";
  return claude ? "claude_code" : UNKNOWN_HARNESS;
}

export const UNKNOWN_HARNESS = "unknown";

/** `--codex-home DIR` in the recorded argv, or null for the default. */
export function codexHomeOf(entry: RosterEntry | null): string | null {
  if (entry === null) return null;
  const i = entry.command.indexOf("--codex-home");
  const v = i === -1 ? undefined : entry.command[i + 1];
  return v === undefined || v === "" ? null : v;
}

/** session.* for one folder, on the real tmux and the real MCP servers. */
export function liveSessionOps(env: Env, dir: string, echo: (line: string) => void = () => {}): SessionOps {
  const restart = liveRestartDeps(env, echo);
  return new SessionOps({
    entry: () => rosterFor(env, dir),
    harness: () => harnessOf(rosterFor(env, dir), dir),
    panePid: (session) => panePid(restart.tmux, session),
    restart: (entry) => restartSession(restart, entry),
    snapshot: (harness) => snapshotTools(harness, dir, { env }),
    baselinePath: (session) => `${stateEntry("sessions", env)}/${session}.tools.json`,
  });
}

export function liveHostDeps(env: Env, log: (line: string) => void): HostDeps {
  return {
    sessionFor: (dir) => liveSessionOps(env, dir),
    env,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    log,
    harnessFor: (dir) => harnessOf(rosterFor(env, dir), dir),
    codexHomeFor: (dir) => codexHomeOf(rosterFor(env, dir)),
    terminal: liveTerminalDeps(env),
  };
}
