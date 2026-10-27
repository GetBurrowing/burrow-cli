/** The real dependencies of {@link HostManager}: the roster and the WebSocket. */
import { readFileSync } from "node:fs";
import type { SocketLike } from "../codex/phoenix.ts";
import { parseRoster, rosterPath, type RosterEntry } from "../roster.ts";
import { canonicalDir } from "../agent_connections.ts";
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

export function harnessOf(entry: RosterEntry | null): string {
  return entry === null ? "claude_code" : HARNESS[entry.kind];
}

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
    harness: () => harnessOf(rosterFor(env, dir)),
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
    harnessFor: (dir) => harnessOf(rosterFor(env, dir)),
    codexHomeFor: (dir) => codexHomeOf(rosterFor(env, dir)),
  };
}
