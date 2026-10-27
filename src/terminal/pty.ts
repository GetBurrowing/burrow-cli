/**
 * The pty for one tmux client.
 *
 * Bun's built-in terminal support (`Bun.spawn({ terminal })`, present in the
 * bun this repo's CI installs) gives the child a real controlling pty with no
 * native npm addon and no `script(1)` shim, so one code path serves macOS and
 * Linux. Bytes are passed through as they arrive: nothing here reads them.
 */
export interface PtyHandle {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Ends THIS client only. */
  kill(): void;
}

export type SpawnPty = (
  argv: string[],
  opts: { cols: number; rows: number; env: Record<string, string>; cwd?: string },
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number | null) => void,
) => PtyHandle;

export const livePty: SpawnPty = (argv, opts, onData, onExit) => {
  const proc = Bun.spawn(argv, {
    env: opts.env,
    cwd: opts.cwd,
    terminal: { cols: opts.cols, rows: opts.rows, data: (_t: unknown, d: Uint8Array) => onData(d) },
  } as unknown as Parameters<typeof Bun.spawn>[1]) as unknown as {
    terminal: { write(d: Uint8Array | string): void; resize(c: number, r: number): void; close?(): void };
    kill(): void;
    exited: Promise<number>;
  };
  void proc.exited.then((code) => onExit(code));
  return {
    write: (b) => proc.terminal.write(b),
    resize: (c, r) => proc.terminal.resize(c, r),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      try {
        proc.terminal.close?.();
      } catch {
        /* already closed */
      }
    },
  };
};
