/**
 * A minimal Phoenix channels client: one socket, one channel, the v2 JSON
 * serializer, heartbeats, and reconnect with backoff.
 *
 * WHY NOT THE `phoenix` PACKAGE. The dsh federation plugin uses it, with `ws`
 * underneath, and installs both into the harness directory. This CLI itself
 * ships with no runtime dependencies beyond bun, and bun has a WebSocket. The
 * part of Phoenix this needs is small and fixed: the wire format is
 * `[join_ref, ref, topic, event, payload]`, a heartbeat is a push on the
 * `phoenix` topic, and a join is a `phx_join` whose `phx_reply` says ok or
 * error. That is what is implemented — no presence, no multiple channels.
 *
 * The URL shape matches what the Phoenix JS client builds from the same
 * endpoint (`<endpoint>/websocket?<params>&vsn=2.0.0`), so the server sees
 * exactly what the existing channel plugins send.
 */

export type Payload = Record<string, unknown>;

/** The subset of the WebSocket API used here, so a test can inject a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  /** Optional: set to "arraybuffer" so binary frames arrive as bytes. */
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/* ------------------------------------------------------------------------- */
/* Phoenix V2 binary frames                                                   */
/* ------------------------------------------------------------------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A client push carrying raw bytes: kind 0, four one-byte sizes, strings, payload. */
export function encodeBinaryPush(
  joinRef: string | null,
  ref: string,
  topic: string,
  event: string,
  payload: Uint8Array,
): Uint8Array {
  const j = enc.encode(joinRef ?? "");
  const r = enc.encode(ref);
  const t = enc.encode(topic);
  const e = enc.encode(event);
  for (const part of [j, r, t, e]) if (part.length > 255) throw new Error("binary push: header field over 255 bytes");
  const out = new Uint8Array(5 + j.length + r.length + t.length + e.length + payload.length);
  out.set([0, j.length, r.length, t.length, e.length], 0);
  let at = 5;
  for (const part of [j, r, t, e, payload]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type BinaryFrame =
  | { kind: "push"; joinRef: string; topic: string; event: string; payload: Uint8Array }
  | { kind: "reply"; joinRef: string; ref: string; topic: string; status: string; payload: Uint8Array }
  | { kind: "broadcast"; topic: string; event: string; payload: Uint8Array };

/** Decode a server-to-client binary frame; null when it is malformed. */
export function decodeBinaryFrame(data: Uint8Array): BinaryFrame | null {
  const kind = data[0];
  const take = (from: number, n: number): [string, number] | null =>
    from + n > data.length ? null : [dec.decode(data.subarray(from, from + n)), from + n];
  if (kind === 0 && data.length >= 4) {
    const sizes = [data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    let at = 4;
    const out: string[] = [];
    for (const n of sizes) {
      const got = take(at, n);
      if (got === null) return null;
      out.push(got[0]);
      at = got[1];
    }
    return { kind: "push", joinRef: out[0] ?? "", topic: out[1] ?? "", event: out[2] ?? "", payload: data.slice(at) };
  }
  if (kind === 1 && data.length >= 5) {
    const sizes = [data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0];
    let at = 5;
    const out: string[] = [];
    for (const n of sizes) {
      const got = take(at, n);
      if (got === null) return null;
      out.push(got[0]);
      at = got[1];
    }
    return { kind: "reply", joinRef: out[0] ?? "", ref: out[1] ?? "", topic: out[2] ?? "", status: out[3] ?? "", payload: data.slice(at) };
  }
  if (kind === 2 && data.length >= 3) {
    const sizes = [data[1] ?? 0, data[2] ?? 0];
    let at = 3;
    const out: string[] = [];
    for (const n of sizes) {
      const got = take(at, n);
      if (got === null) return null;
      out.push(got[0]);
      at = got[1];
    }
    return { kind: "broadcast", topic: out[0] ?? "", event: out[1] ?? "", payload: data.slice(at) };
  }
  return null;
}

export type SocketFactory = (url: string) => SocketLike;

export const HEARTBEAT_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
const OPEN = 1;

/**
 * `<ws endpoint>/websocket?runtime_id=…&token=…&vsn=2.0.0`.
 *
 * The token rides in the query string because that is where the runtime
 * socket reads it (`RuntimeSocket.connect/3`); every existing plugin does the
 * same. It is never logged: {@link redactUrl} is what goes into a log line.
 */
export function socketUrl(endpoint: string, params: Record<string, string>): string {
  const u = new URL(endpoint);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/websocket`;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("vsn", "2.0.0");
  return u.toString();
}

export function redactUrl(url: string): string {
  const u = new URL(url);
  if (u.searchParams.has("token")) u.searchParams.set("token", "REDACTED");
  return u.toString();
}

export interface PhoenixOptions {
  url: string;
  topic: string;
  joinPayload: Payload;
  socket: SocketFactory;
  log(line: string): void;
  /** Injected so tests do not wait real seconds. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  heartbeatMs?: number;
}

/**
 * Connects, joins, and stays joined. `on(event, fn)` receives server pushes on
 * the topic; `push(event, payload)` sends one (dropped, and said so, while not
 * joined — a reply cannot be queued across a reconnect without risking a
 * duplicate post).
 */
export class PhoenixChannel {
  private ws: SocketLike | null = null;
  private ref = 0;
  private joinRef: string | null = null;
  private joined = false;
  private stopped = false;
  private attempts = 0;
  private heartbeat: unknown = null;
  private reconnect: unknown = null;
  private readonly handlers = new Map<string, ((payload: Payload) => void)[]>();
  private readonly binaryHandlers = new Map<string, ((payload: Uint8Array) => void)[]>();
  private readonly onDroppedFns: (() => void)[] = [];
  private readonly replies = new Map<string, (status: string, response: Payload) => void>();
  private readonly onJoinedFns: (() => void)[] = [];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: PhoenixOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isJoined(): boolean {
    return this.joined;
  }

  on(event: string, fn: (payload: Payload) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }

  /** Receive a binary server push (`in`, …) on the topic. */
  onBinary(event: string, fn: (payload: Uint8Array) => void): void {
    this.binaryHandlers.set(event, [...(this.binaryHandlers.get(event) ?? []), fn]);
  }

  /** Called whenever the socket closes or the channel is closed or errored under us. */
  onDropped(fn: () => void): void {
    this.onDroppedFns.push(fn);
  }

  /** Send raw bytes as a Phoenix V2 binary push. False when not joined. */
  pushBinary(event: string, payload: Uint8Array): boolean {
    if (!this.joined || this.ws === null || this.ws.readyState !== OPEN || this.joinRef === null) return false;
    this.ws.send(encodeBinaryPush(this.joinRef, this.nextRef(), this.opts.topic, event, payload));
    return true;
  }

  onJoined(fn: () => void): void {
    this.onJoinedFns.push(fn);
  }

  connect(): void {
    if (this.stopped) return;
    this.opts.log(`connecting to ${redactUrl(this.opts.url)}`);
    const ws = this.opts.socket(this.opts.url);
    this.ws = ws;
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* a fake may not allow it */
    }
    ws.onopen = () => {
      this.attempts = 0;
      this.startHeartbeat();
      this.join();
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer) this.receiveBinary(new Uint8Array(d));
      else if (d instanceof Uint8Array) this.receiveBinary(d);
      else this.receive(String(d));
    };
    ws.onerror = () => this.opts.log("socket error");
    ws.onclose = () => {
      this.joined = false;
      this.stopHeartbeat();
      for (const fn of this.onDroppedFns) fn();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  /** Send one event. Resolves with the server's reply status, or "dropped". */
  push(event: string, payload: Payload): Promise<{ status: string; response: Payload }> {
    if (!this.joined || this.ws === null || this.ws.readyState !== OPEN) {
      this.opts.log(`not joined; dropped ${event}`);
      return Promise.resolve({ status: "dropped", response: {} });
    }
    const ref = this.nextRef();
    this.send([this.joinRef, ref, this.opts.topic, event, payload]);
    return new Promise((resolve) => {
      this.replies.set(ref, (status, response) => resolve({ status, response }));
      // A reply that never comes must not hold a caller forever.
      this.setTimer(() => {
        if (this.replies.delete(ref)) resolve({ status: "timeout", response: {} });
      }, 10_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnect !== null) this.clearTimer(this.reconnect);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private send(frame: unknown[]): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private join(): void {
    this.joinRef = this.nextRef();
    const ref = this.joinRef;
    this.send([ref, ref, this.opts.topic, "phx_join", this.opts.joinPayload]);
    this.replies.set(ref, (status, response) => {
      if (status === "ok") {
        this.joined = true;
        this.opts.log(`joined ${this.opts.topic}`);
        for (const fn of this.onJoinedFns) fn();
      } else {
        this.opts.log(`join refused: ${JSON.stringify(response)}`);
        try {
          this.ws?.close();
        } catch {
          /* closing anyway */
        }
      }
    });
  }

  private receive(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [, ref, topic, event, payload] = frame as [string | null, string | null, string, string, Payload];
    if (event === "phx_reply" && ref !== null) {
      const fn = this.replies.get(ref);
      if (fn !== undefined) {
        this.replies.delete(ref);
        const p = (payload ?? {}) as { status?: string; response?: Payload };
        fn(p.status ?? "error", p.response ?? {});
      }
      return;
    }
    if (topic !== this.opts.topic) return;
    if (event === "phx_close" || event === "phx_error") {
      this.joined = false;
      for (const fn of this.onDroppedFns) fn();
      this.opts.log(`channel ${event}; rejoining`);
      this.join();
      return;
    }
    for (const fn of this.handlers.get(event) ?? []) fn(payload ?? {});
  }

  private receiveBinary(data: Uint8Array): void {
    const f = decodeBinaryFrame(data);
    if (f === null || f.kind !== "push" || f.topic !== this.opts.topic) return;
    for (const fn of this.binaryHandlers.get(f.event) ?? []) fn(f.payload);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      this.send([null, this.nextRef(), "phoenix", "heartbeat", {}]);
      this.heartbeat = this.setTimer(beat, this.opts.heartbeatMs ?? HEARTBEAT_MS);
    };
    this.heartbeat = this.setTimer(beat, this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.clearTimer(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnect !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts += 1;
    this.opts.log(`socket closed; reconnecting in ${delay}ms`);
    this.reconnect = this.setTimer(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }
}
