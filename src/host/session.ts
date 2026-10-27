/**
 * `session.tools` and `session.restart` over `runtime_host:<runtime_id>`
 * (task 01a17b1c stage 4).
 *
 * BEFORE means "what the RUNNING process loaded", not "what the config says
 * now": by the time someone restarts, the config has usually changed (that is
 * why they restart). So the host keeps a BASELINE per session: a snapshot taken
 * when it first sees a pane process (each `burrow watch` pass, see
 * {@link SessionOps.observe}) and after every restart, stored with that pane's
 * pid. A restart's `before` is the baseline whose pid is the live pane's pid.
 * When there is none (the host had not yet seen this process), `before` is
 * probed at the moment of the restart and `before_basis` says `now`, so the
 * install can say the diff may be incomplete instead of implying it is exact.
 * The remaining imprecision: a config edit made between a launch and the
 * next watch pass is counted as already loaded.
 *
 * The relaunch itself lives OUTSIDE src/host (session_restart.ts) and is
 * injected; nothing in this folder talks to tmux.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RosterEntry } from "../roster.ts";
import type { RestartResult } from "../session_restart.ts";
import { diffTools, type ToolSnapshot } from "./tools.ts";
import type { Reply } from "./ops.ts";

export interface SessionDeps {
  /** The roster entry recorded for this folder, or null. */
  entry(): RosterEntry | null;
  /** The harness kind for the snapshot (`claude_code` | `codex` | …). */
  harness(): string;
  panePid(session: string): Promise<number | null>;
  restart(entry: RosterEntry): Promise<RestartResult>;
  snapshot(harness: string): Promise<ToolSnapshot>;
  /** Where the baseline for a session is kept (0600). */
  baselinePath(session: string): string;
}

interface Baseline {
  version: 1;
  session: string;
  pid: number;
  snapshot: ToolSnapshot;
}

function readBaseline(path: string): Baseline | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const b = JSON.parse(readFileSync(path, "utf8")) as Partial<Baseline>;
    if (b.version !== 1 || typeof b.pid !== "number" || !Array.isArray(b.snapshot?.tools)) return null;
    return b as Baseline;
  } catch {
    return null;
  }
}

function writeBaseline(path: string, b: Baseline): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(b)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    /* a baseline that cannot be kept only costs the next diff its precision */
  }
}

export class SessionOps {
  private inflight = false;
  private observing = false;

  constructor(private readonly d: SessionDeps) {}

  /** Take a baseline for the live pane process if there is none yet. Never throws. */
  async observe(): Promise<void> {
    if (this.inflight || this.observing) return;
    this.observing = true;
    try {
      const entry = this.d.entry();
      if (entry === null) return;
      const pid = await this.d.panePid(entry.session);
      if (pid === null) return;
      const path = this.d.baselinePath(entry.session);
      if (readBaseline(path)?.pid === pid) return;
      const snapshot = await this.d.snapshot(this.d.harness());
      if (this.inflight) return; // a restart began meanwhile: its own record wins
      writeBaseline(path, { version: 1, session: entry.session, pid, snapshot });
    } catch {
      /* best effort */
    } finally {
      this.observing = false;
    }
  }

  async handle(event: string): Promise<Reply> {
    if (event === "session.tools") return this.tools();
    if (event === "session.restart") return this.restart();
    return { error: "unsupported" };
  }

  private async tools(): Promise<Reply> {
    const entry = this.d.entry();
    if (entry === null) return { error: "no_recorded_session" };
    const pid = await this.d.panePid(entry.session);
    const base = pid === null ? null : readBaseline(this.d.baselinePath(entry.session));
    const loaded = base !== null && base.pid === pid ? base.snapshot : null;
    return { ok: { session: entry.session, running: pid !== null, loaded, configured: await this.d.snapshot(this.d.harness()) } };
  }

  private async restart(): Promise<Reply> {
    const entry = this.d.entry();
    if (entry === null) return { error: "no_recorded_session" };
    if (this.inflight) return { error: "restart_in_progress" };
    this.inflight = true;
    try {
      const harness = this.d.harness();
      const pid = await this.d.panePid(entry.session);
      if (pid === null) return { error: "not_running" };
      const path = this.d.baselinePath(entry.session);
      const base = readBaseline(path);
      const exact = base !== null && base.pid === pid;
      const before = exact ? base.snapshot : await this.d.snapshot(harness);
      const res = await this.d.restart(entry);
      if (!res.ok) return { error: res.reason };
      const after = await this.d.snapshot(harness);
      if (res.pid_after !== null) writeBaseline(path, { version: 1, session: entry.session, pid: res.pid_after, snapshot: after });
      return {
        ok: {
          session: entry.session,
          outcome: res.outcome,
          resumed: res.resumed,
          before,
          after,
          before_basis: exact ? "loaded" : "now",
          relaunched: res.pid_after !== null && res.pid_after !== res.pid_before,
          diff: diffTools(before.tools, after.tools),
        },
      };
    } finally {
      this.inflight = false;
    }
  }
}
