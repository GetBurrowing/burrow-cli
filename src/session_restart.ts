/**
 * RESTART AN AGENT'S SESSION: relaunch the harness PROCESS in its tmux pane,
 * with the argv it was started with (task 01a17b1c stage 4).
 *
 * Why a relaunch and nothing gentler. A harness reads its instructions,
 * settings and MCP config when it STARTS. `burrow watch --force`
 * (`forceRecover`, commands/watch.ts) types a reorientation into the live pane;
 * the process stays, so a server added to `.mcp.json` is never loaded. That
 * path is deliberately not used here.
 *
 * What it does:
 *   1. read the session's recorded launch from the roster (roster.ts). That is
 *      the full `tmux new-session … <pane command>` argv; the pane command is
 *      everything after tmux's own options. For claude it is the `/bin/sh`
 *      fallback wrapper around `claude … --continue`, so the relaunch keeps
 *      `--continue` AND its no-conversation fallback; for codex it is
 *      `burrow codex --no-session`, which resumes each space's thread;
 *   2. `tmux respawn-pane -k` on that session's pane with exactly that command
 *      and the recorded working directory. `-k` kills the old process; the new
 *      one is a fresh process that re-reads its config;
 *   3. wait for the launch outcome. For claude that is the same launch watcher
 *      every `burrow claude` launch runs (claude_dialogs.ts, injected as
 *      {@link RestartDeps.watchLaunch}); it writes the launch record
 *      (claude_launch.ts) that pane-status reads. Nothing it sees leaves this
 *      machine: only the outcome word is returned.
 *
 * NO TERMINAL BYTES. This module types nothing into a pane and reads no pane
 * text: its tmux calls are `respawn-pane` and `list-panes -F #{pane_pid}`. A
 * guard test (test/session_restart.test.ts) greps it for the pane-typing and
 * pane-reading verbs.
 */
import { answerLaunchDialogs, liveDialogIo } from "./claude_dialogs.ts";
import { launchRecordPath, writeLaunchRecord, type LaunchRecord } from "./claude_launch.ts";
import { authError } from "./claude_login.ts";
import { resolveTmux } from "./halt.ts";
import type { RosterEntry } from "./roster.ts";
import { liveTmuxDeps, type RunResult } from "./tmux.ts";

export type RestartOutcome = "ready" | "timeout" | "gone";

export interface RestartTmux {
  run(argv: string[]): Promise<RunResult>;
  which(name: string): string | null;
}

export interface RestartDeps {
  tmux: RestartTmux;
  /**
   * Wait until the relaunched harness is up. For claude: the launch-dialog
   * watcher, which writes the launch record. Absent: a settle-and-check.
   */
  watchLaunch?(entry: RosterEntry): Promise<RestartOutcome>;
  sleep?(ms: number): Promise<void>;
}

/** tmux's exact-match target for a session's active pane. */
export function paneTarget(session: string): string {
  return `=${session}:`;
}

/** `new-session` options that take a value, so their value is skipped. */
const VALUE_FLAGS = new Set(["-s", "-c", "-n", "-t", "-x", "-y", "-e", "-F", "-f"]);

/**
 * (recorded `tmux new-session` argv) → the pane command, or null when the
 * record is not a `new-session` launch. The pane command starts at the first
 * argument after `new-session` that is not one of tmux's options.
 */
export function paneCommandOf(recorded: readonly string[]): string[] | null {
  const at = recorded.indexOf("new-session");
  if (at === -1) return null;
  let i = at + 1;
  while (i < recorded.length) {
    const a = recorded[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a.length < 2) break;
    i += VALUE_FLAGS.has(a) ? 2 : 1;
  }
  const cmd = recorded.slice(i);
  return cmd.length === 0 ? null : cmd;
}

/** The exact `respawn-pane` argv for a roster entry. Pure. */
export function respawnArgv(entry: RosterEntry, tmux = "tmux"): string[] | null {
  const cmd = paneCommandOf(entry.command);
  if (cmd === null) return null;
  return [tmux, "respawn-pane", "-k", "-t", paneTarget(entry.session), "-c", entry.cwd, ...cmd];
}

/** Does the relaunch continue the conversation? claude with `--continue`; codex resumes threads. */
export function resumes(entry: RosterEntry): boolean {
  if (entry.kind === "codex") return true;
  // `--continue` as a whole argv element: the pane wrapper's script text is one
  // element and never matches. A user-chosen `--resume <id>` also continues.
  if (entry.kind === "claude") return entry.command.includes("--continue") || entry.command.includes("--resume");
  return false;
}

/** The pid of the session's pane process, or null when the session is not running. */
export async function panePid(tmux: RestartTmux, session: string): Promise<number | null> {
  const r = await tmux.run([resolveTmux(tmux.which), "list-panes", "-t", paneTarget(session), "-F", "#{pane_pid}"]);
  if (r.exitCode !== 0) return null;
  const pid = Number.parseInt(r.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export type RestartResult =
  | { ok: true; outcome: RestartOutcome; resumed: boolean; pid_before: number; pid_after: number | null }
  | { ok: false; reason: "no_recorded_launch" | "not_running" | "respawn_failed" };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SETTLE_MS = 1_500;

/** Relaunch the session's harness in place. */
export async function restartSession(deps: RestartDeps, entry: RosterEntry): Promise<RestartResult> {
  const tmux = resolveTmux(deps.tmux.which);
  const argv = respawnArgv(entry, tmux);
  if (argv === null) return { ok: false, reason: "no_recorded_launch" };
  const before = await panePid(deps.tmux, entry.session);
  if (before === null) return { ok: false, reason: "not_running" };
  const r = await deps.tmux.run(argv);
  if (r.exitCode !== 0) return { ok: false, reason: "respawn_failed" };
  let outcome: RestartOutcome;
  if (deps.watchLaunch !== undefined) {
    outcome = await deps.watchLaunch(entry);
  } else {
    await (deps.sleep ?? realSleep)(SETTLE_MS);
    outcome = (await panePid(deps.tmux, entry.session)) === null ? "gone" : "ready";
  }
  const after = await panePid(deps.tmux, entry.session);
  if (after === null && outcome === "ready") outcome = "gone";
  return { ok: true, outcome, resumed: resumes(entry), pid_before: before, pid_after: after };
}

/* ------------------------------------------------------------------------- */
/* Live wiring                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The real deps: tmux on PATH, and for claude the launch-dialog watcher that
 * every `burrow claude` launch runs, writing the launch record as it does.
 */
export function liveRestartDeps(env: Record<string, string | undefined>, echo: (line: string) => void = () => {}): RestartDeps {
  const tmux = liveTmuxDeps(env);
  const home = env.HOME ?? "";
  return {
    tmux,
    watchLaunch: async (entry) => {
      if (entry.kind !== "claude") {
        await realSleep(SETTLE_MS);
        return (await panePid(tmux, entry.session)) === null ? "gone" : "ready";
      }
      const path = launchRecordPath(home, entry.session, env);
      const startedAt = new Date().toISOString();
      const write = (r: LaunchRecord) => {
        try {
          writeLaunchRecord(path, r);
        } catch {
          /* bookkeeping never fails a restart */
        }
      };
      write({ version: 1, session: entry.session, outcome: "pending", started_at: startedAt });
      const result = await answerLaunchDialogs(liveDialogIo(tmux, home, echo), {
        session: entry.session,
        cwd: entry.cwd,
        home,
        apiKey: env.ANTHROPIC_API_KEY,
      });
      write({
        version: 1,
        session: entry.session,
        outcome: result.outcome,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        answered: result.answered.map((a) => a.dialog),
        baseline: result.pane === undefined ? null : (authError(result.pane)?.signature ?? null),
      });
      return result.outcome;
    },
  };
}
