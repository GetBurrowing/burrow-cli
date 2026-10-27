/**
 * ONE socket per agent folder, many topics on it.
 *
 * The structured operations ride `runtime_host:<runtime_id>`. The remote
 * terminal (task 01a17b17) rides `terminal:<runtime_id>` on this same socket
 * once it registers a topic here: structured ops and terminal bytes share a
 * connection, never a topic. `topic()` is the attach point; nothing in this
 * file knows what a topic carries.
 *
 * Wire format and URL shape are the Phoenix v2 JSON ones that
 * src/codex/phoenix.ts uses (it speaks one topic per socket, so it cannot be
 * shared as is); the helpers are imported from it, not copied. The token rides
 * in the query string because that is where RuntimeSocket reads it, and it is
 * never logged: every log line goes through redactUrl.
 *
 * Binary frames (the terminal's sealed bytes) use the Phoenix V2 binary
 * encoding from the same module; JSON topics are unaffected by them.
 */
import {
  HEARTBEAT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  decodeBinaryFrame,
  encodeBinaryPush,
  redactUrl,
  type Payload,
  type SocketFactory,
  type SocketLike,
} from "../codex/phoenix.ts";

const OPEN = 1;

export interface TopicHandle {
  readonly topic: string;
  /** Receive a server push on this topic. */
  on(event: string, fn: (payload: Payload) => void): void;
  /** Send an event on this topic; false when the topic is not joined. */
  push(event: string, payload: Payload): boolean;
  isJoined(): boolean;
  /** Called after every (re)join. */
  onJoined(fn: () => void): void;
  /** Receive a binary server push on this topic. */
  onBinary(event: string, fn: (payload: Uint8Array) => void): void;
  /** Send raw bytes as a binary push; false when the topic is not joined. */
  pushBinary(event: string, payload: Uint8Array): boolean;
  /** Called whenever the topic stops being joined: socket closed, or the channel closed or errored under us. */
  onDropped(fn: () => void): void;
}

interface TopicState {
  joinPayload: () => Payload;
  joinRef: string | null;
  joined: boolean;
  handlers: Map<string, ((p: Payload) => void)[]>;
  binaryHandlers: Map<string, ((p: Uint8Array) => void)[]>;
  joinedFns: (() => void)[];
  droppedFns: (() => void)[];
}

export interface HostSocketOptions {
  url: string;
  socket: SocketFactory;
  log(line: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
}

export class HostSocket {
  private ws: SocketLike | null = null;
  private ref = 0;
  private stopped = false;
  private attempts = 0;
  private heartbeat: unknown = null;
  private reconnect: unknown = null;
  private readonly topics = new Map<string, TopicState>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly opts: HostSocketOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Register a topic to join whenever the socket is up. The payload is read at each join. */
  topic(name: string, joinPayload: () => Payload): TopicHandle {
    const existing = this.topics.get(name);
    if (existing !== undefined) throw new Error(`topic ${name} is already registered`);
    const st: TopicState = {
      joinPayload,
      joinRef: null,
      joined: false,
      handlers: new Map(),
      binaryHandlers: new Map(),
      joinedFns: [],
      droppedFns: [],
    };
    this.topics.set(name, st);
    if (this.ws !== null && this.ws.readyState === OPEN) this.join(name, st);
    return {
      topic: name,
      on: (event, fn) => st.handlers.set(event, [...(st.handlers.get(event) ?? []), fn]),
      push: (event, payload) => this.pushOn(name, st, event, payload),
      isJoined: () => st.joined,
      onJoined: (fn) => st.joinedFns.push(fn),
      onBinary: (event, fn) => st.binaryHandlers.set(event, [...(st.binaryHandlers.get(event) ?? []), fn]),
      pushBinary: (event, payload) => this.pushBinaryOn(name, st, event, payload),
      onDropped: (fn) => st.droppedFns.push(fn),
    };
  }

  /** Leave a topic and forget it. The socket and its other topics stay up. */
  leaveTopic(name: string): void {
    const st = this.topics.get(name);
    if (st === undefined) return;
    this.topics.delete(name);
    if (st.joined && this.ws !== null && this.ws.readyState === OPEN) this.send([st.joinRef, this.nextRef(), name, "phx_leave", {}]);
    st.joined = false;
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
      for (const [name, st] of this.topics) this.join(name, st);
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer) this.receiveBinary(new Uint8Array(d));
      else if (d instanceof Uint8Array) this.receiveBinary(d);
      else this.receive(String(d));
    };
    ws.onerror = () => this.opts.log("socket error");
    ws.onclose = () => {
      for (const st of this.topics.values()) {
        const wasJoined = st.joined;
        st.joined = false;
        st.joinRef = null;
        if (wasJoined) for (const fn of st.droppedFns) fn();
      }
      this.stopHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
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

  private join(name: string, st: TopicState): void {
    st.joinRef = this.nextRef();
    this.send([st.joinRef, st.joinRef, name, "phx_join", st.joinPayload()]);
  }

  private pushOn(name: string, st: TopicState, event: string, payload: Payload): boolean {
    if (!st.joined || this.ws === null || this.ws.readyState !== OPEN) return false;
    this.send([st.joinRef, this.nextRef(), name, event, payload]);
    return true;
  }

  private pushBinaryOn(name: string, st: TopicState, event: string, payload: Uint8Array): boolean {
    if (!st.joined || st.joinRef === null || this.ws === null || this.ws.readyState !== OPEN) return false;
    this.ws.send(encodeBinaryPush(st.joinRef, this.nextRef(), name, event, payload));
    return true;
  }

  private receiveBinary(data: Uint8Array): void {
    const f = decodeBinaryFrame(data);
    if (f === null || f.kind !== "push") return;
    const st = this.topics.get(f.topic);
    if (st === undefined) return;
    for (const fn of st.binaryHandlers.get(f.event) ?? []) fn(f.payload);
  }

  private receive(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [joinRef, , topic, event, payload] = frame as [string | null, string | null, string, string, Payload];
    const st = this.topics.get(topic);
    if (st === undefined) return;
    if (event === "phx_reply") {
      if (joinRef !== null && joinRef === st.joinRef && !st.joined) {
        const p = (payload ?? {}) as { status?: string };
        if (p.status === "ok") {
          st.joined = true;
          this.opts.log(`joined ${topic}`);
          for (const fn of st.joinedFns) fn();
        } else {
          this.opts.log(`join of ${topic} refused`);
        }
      }
      return;
    }
    if (event === "phx_close" || event === "phx_error") {
      st.joined = false;
      for (const fn of st.droppedFns) fn();
      this.opts.log(`${topic}: ${event}; rejoining`);
      this.join(topic, st);
      return;
    }
    for (const fn of st.handlers.get(event) ?? []) fn(payload ?? {});
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      this.send([null, this.nextRef(), "phoenix", "heartbeat", {}]);
      this.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
    };
    this.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
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
