/** The real pty and tmux for the remote terminal hosted in `burrow watch`. */
import { liveTmuxDeps } from "../tmux.ts";
import type { TerminalDeps } from "./host.ts";
import { livePty } from "./pty.ts";

export function liveTerminalDeps(env: Record<string, string | undefined>): TerminalDeps {
  return { spawn: livePty, tmux: (argv) => liveTmuxDeps(env).run(argv) };
}
