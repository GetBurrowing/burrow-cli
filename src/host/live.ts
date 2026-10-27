/** The real dependencies of {@link HostManager}: the roster and the WebSocket. */
import { readFileSync } from "node:fs";
import type { SocketLike } from "../codex/phoenix.ts";
import { parseRoster, rosterPath, type RosterEntry } from "../roster.ts";
import { canonicalDir } from "../agent_connections.ts";
import type { HostDeps } from "./manager.ts";

type Env = Record<string, string | undefined>;

function rosterFor(env: Env, dir: string): RosterEntry | null {
  try {
    const entries = parseRoster(readFileSync(rosterPath(env.HOME ?? "", env), "utf8"));
    const canon = canonicalDir(dir);
    return entries.find((e) => canonicalDir(e.cwd) === canon) ?? null;
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

export function liveHostDeps(env: Env, log: (line: string) => void): HostDeps {
  return {
    env,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    log,
    harnessFor: (dir) => harnessOf(rosterFor(env, dir)),
    codexHomeFor: (dir) => codexHomeOf(rosterFor(env, dir)),
  };
}
