/**
 * The terminal bridge: a dumb pipe between a tmux client and an encrypted
 * channel to the owner's browser.
 *
 * - It acts only on a core `open`; it never opens a pty on its own.
 * - Read-only by default, on every new `open`. Writing needs a `mode rw` from
 *   core; while read-only an `in` frame is dropped before it is even decrypted.
 * - It never inspects the bytes it forwards and never logs them: log lines
 *   carry event names and sizes.
 * - Leaving means killing only this bridge's own tmux client. The session and
 *   the agent in it are never touched.
 */
import { TMUX } from "../tmux.ts";
import type { PtyHandle, SpawnPty } from "./pty.ts";
import { DIR_BROWSER_TO_CLI, DIR_CLI_TO_BROWSER, KIND_CONTROL, KIND_DATA, Receiver, Sender, deriveKeys, fromB64, generateKeyPair, toB64, type KeyPair } from "./crypto.ts";

/** What the bridge needs of the channel (PhoenixChannel satisfies it). */
export interface BridgeChannel {
  on(event: string, fn: (payload: Record<string, unknown>) => void): void;
  onBinary(event: string, fn: (payload: Uint8Array) => void): void;
  onDropped(fn: () => void): void;
  push(event: string, payload: Record<string, unknown>): Promise<unknown>;
  pushBinary(event: string, payload: Uint8Array): boolean;
}

export interface BridgeOptions {
  session: string;
  channel: BridgeChannel;
  spawn: SpawnPty;
  env: Record<string, string | undefined>;
  /** The session's current folder, sent inside the first encrypted record. */
  folder(): Promise<string>;
  log(line: string): void;
  keyPair?: () => KeyPair;
}

/** `tmux attach-session`, read-only unless `writable`. Never kills anything. */
export function attachClientArgv(session: string, writable: boolean): string[] {
  return writable ? [TMUX, "attach-session", "-t", session] : [TMUX, "attach-session", "-r", "-t", session];
}

type Mode = "ro" | "rw";

interface Live {
  sessionId: string;
  keys: KeyPair;
  send?: Sender;
  recv?: Receiver;
  pty?: PtyHandle;
  mode: Mode;
  cols: number;
  rows: number;
  firstSent: boolean;
}

export class TerminalBridge {
  private live: Live | null = null;

  constructor(private readonly o: BridgeOptions) {
    o.channel.on("open", (p) => this.onOpen(p));
    o.channel.on("hello", (p) => void this.onHello(p));
    o.channel.on("mode", (p) => this.onMode(p));
    o.channel.on("resize", (p) => this.onResize(p));
    o.channel.on("detach", () => this.onDetach());
    o.channel.onBinary("in", (b) => this.onInput(b));
    o.channel.onDropped(() => this.end("socket dropped"));
  }

  get active(): boolean {
    return this.live !== null;
  }

  get mode(): Mode | null {
    return this.live?.mode ?? null;
  }

  private onOpen(p: Record<string, unknown>): void {
    this.end("new open");
    const sessionId = typeof p.session_id === "string" ? p.session_id : "";
    if (sessionId === "") {
      this.o.log("open ignored: no session_id");
      return;
    }
    const keys = (this.o.keyPair ?? generateKeyPair)();
    // Every open starts read-only, whatever the last one ended as.
    this.live = { sessionId, keys, mode: "ro", cols: 80, rows: 24, firstSent: false };
    this.o.log("open");
    void this.o.channel.push("hello", { pub: toB64(keys.publicKey) });
  }

  private async onHello(p: Record<string, unknown>): Promise<void> {
    const live = this.live;
    if (live === null || live.send !== undefined) return;
    let peer: Uint8Array;
    try {
      peer = fromB64(typeof p.pub === "string" ? p.pub : "");
      if (peer.length !== 32) throw new Error("length");
      const k = deriveKeys("cli", live.keys.privateKey, peer, live.sessionId);
      live.send = new Sender(k.send, DIR_CLI_TO_BROWSER);
      live.recv = new Receiver(k.recv, DIR_BROWSER_TO_CLI);
    } catch {
      this.o.log("hello rejected");
      this.end("bad hello");
      return;
    }
    this.o.log("hello");
    let folder = "";
    try {
      folder = await this.o.folder();
    } catch {
      /* the folder is a nicety */
    }
    if (this.live !== live) return;
    this.sealAndPush(live, KIND_CONTROL, new TextEncoder().encode(JSON.stringify({ cwd: folder })));
    live.firstSent = true;
    this.attach(live);
  }

  private attach(live: Live): void {
    const argv = attachClientArgv(this.o.session, live.mode === "rw");
    // The bridge itself runs inside tmux; a client started with TMUX set would
    // refuse to nest.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.env)) if (v !== undefined && k !== "TMUX" && k !== "TMUX_PANE") env[k] = v;
    env.TERM = "xterm-256color";
    const pty = this.o.spawn(
      argv,
      { cols: live.cols, rows: live.rows, env },
      (bytes) => {
        if (this.live !== live || live.pty !== pty) return;
        this.o.log(`out ${bytes.length}`);
        this.sealAndPush(live, KIND_DATA, bytes);
      },
      () => {
        if (this.live === live && live.pty === pty) {
          this.o.log("client exited");
          live.pty = undefined;
        }
      },
    );
    live.pty = pty;
  }

  private sealAndPush(live: Live, kind: number, body: Uint8Array): void {
    if (live.send === undefined) return;
    this.o.channel.pushBinary("out", live.send.seal(kind, body));
  }

  private onMode(p: Record<string, unknown>): void {
    const live = this.live;
    if (live === null || (p.mode !== "ro" && p.mode !== "rw")) return;
    this.o.log(`mode ${p.mode}`);
    if (live.mode === p.mode) return;
    live.mode = p.mode;
    if (live.pty !== undefined) {
      // Only this bridge's own client is replaced; the session is untouched.
      const old = live.pty;
      live.pty = undefined;
      old.kill();
      this.attach(live);
    }
  }

  private onResize(p: Record<string, unknown>): void {
    const live = this.live;
    if (live === null) return;
    const cols = Number(p.cols);
    const rows = Number(p.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    this.o.log(`resize ${cols}x${rows}`);
    live.cols = cols;
    live.rows = rows;
    live.pty?.resize(cols, rows);
  }

  private onInput(frame: Uint8Array): void {
    const live = this.live;
    if (live === null || live.pty === undefined || live.recv === undefined) return;
    if (live.mode !== "rw") {
      this.o.log(`in ${frame.length} dropped (ro)`);
      return;
    }
    const rec = live.recv.open(frame);
    if (rec === null) {
      this.o.log(`in ${frame.length} rejected`);
      return;
    }
    if (rec.kind !== KIND_DATA) return;
    this.o.log(`in ${rec.body.length}`);
    live.pty.write(rec.body);
  }

  private onDetach(): void {
    this.o.log("detach");
    this.end("detach");
  }

  /** Kill our own client and forget the session's keys. */
  end(_why: string): void {
    const live = this.live;
    if (live === null) return;
    this.live = null;
    live.pty?.kill();
  }
}
