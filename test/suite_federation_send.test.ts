// The dsh suite-federation plugin's `suite_reply` send path, live tool trace
// and queued-typing indicator.
//
// WHY suite_reply NEEDS ITS OWN CONTRACT. Core's Chat channel answers a
// `reply` push with `{:noreply, socket}` on BOTH branches, so no phoenix
// reply/ack can ever fire; a refusal arrives instead as a separate `error`
// event. The tool is therefore judged by its absence: it resolves ok only when
// a short grace window passes without one. These tests pin that contract so a
// "helpful" rewrite to `.receive('ok')` fails here first.
//
// The plugin runs inside dsh, whose packages are not dependencies of this
// repo, so they are mocked and the plugin is driven end to end through
// `apply` — registration happens for real, the tool's `execute` is called for
// real, and the channel pushes are what the test asserts on.
import { describe, expect, mock, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";

// Listeners here receive whatever the plugin passes: one payload for channel
// events, two (`session`, `event`) for the session/event trace.
type Handler = (...args: any[]) => void;
const pushes: Array<{ event: string; payload: any }> = [];
const handlers = new Map<string, Handler>();

// Anything callable and chainable: `z.object({...})`, `z.string().required()`.
// `~standard.validate` is what real cordis calls on the plugin's `Config`
// schema (fiber.ts `resolveConfig`), and a truthy `issues` on its result
// throws a ValidationError — so the mock validates and echoes the config.
const chain: any = new Proxy(function () {}, {
  get: (target, prop) => {
    if (prop === "~standard") return { validate: (value: any) => ({ value }) };
    return chain;
  },
  apply: () => chain,
});

class FakeSocket {
  onOpen() {}
  onClose() {}
  onError() {}
  connect() {}
  disconnect() {}
  channel() {
    const receiver = { receive: () => receiver };
    return {
      on: (event: string, fn: Handler) => handlers.set(event, fn),
      // Phoenix's `Socket.off(event, refs)` — the refusal listener is removed
      // once the promise settles. The fake keeps a single slot per event and
      // ignores removals, which is all the contract under test needs.
      off: () => {},
      push: (event: string, payload: any) => pushes.push({ event, payload }),
      join: () => receiver,
      leave() {},
    };
  }
}

mock.module("ws", () => ({ default: class {} }));
mock.module("phoenix", () => ({ Socket: FakeSocket }));
mock.module("@deepseek-ai/schemastery", () => ({ default: chain }));
mock.module("@deepseek-ai/dsh-llm", () => ({ createUserMessage: (m: any) => m }));
mock.module("@deepseek-ai/dsh-session", () => ({ SessionId: (s: string) => s }));
// The tool runtime is not a dependency of this repo. `defineTool` validates
// and decorates a definition; returning it untouched keeps the registered
// object byte-identical to what the plugin wrote.
mock.module("@deepseek-ai/dsh-tools", () => ({ defineTool: (def: any) => def }));

// @ts-expect-error -- untyped JS asset; it runs inside dsh, not this package
const plugin: any = await import("../assets/dsh-plugins/suite-federation/index.js");

/** An agent whose turn blocks on `turnGate`, so a space can be held inflight. */
function fakeCtx(opts: { turnGate?: Promise<void>; tools?: (def: any) => void } = {}) {
  const agent = {
    session: { id: "session-1", seq: 0, events: [] as any[] },
    followup() {
      this.session.events.push({
        type: "assistant/message",
        seq: 1,
        data: {
          message: {
            content: [{ type: "text", text: "done" }],
            source: { provider: "deepseek", model: "deepseek-chat" },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
    },
    whenIdle: async () => {
      await opts.turnGate;
    },
  };
  const services: Record<string, any> = {
    agents: { create: async () => ({ agent }) },
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) },
    sessions: { flush: async () => {} },
  };
  const listeners = new Map<string, Handler>();
  const ctx = {
    // The tools service is RESOLVED through the nested `ctx.inject`, not the
    // plugin's own inject — a missing one must leave the plugin alive.
    // Passing a registrar here is how a test provides it.
    get: (k: string) => (opts.tools && k === "tools" ? { register: opts.tools } : services[k]),
    // Cordis holds a nested `ctx.inject` fiber inactive while any of its
    // dependencies is unmounted and runs its callback once they mount. The
    // fake runs the callback synchronously when tools is available and never
    // otherwise — the same contract from the plugin's point of view.
    inject: (deps: string[], cb: (c: any) => any) => {
      if (deps.includes("tools") && opts.tools) cb(ctx);
    },
    on: (topic: string, fn: Handler) => listeners.set(topic, fn),
    logger: () => ({}),
    listeners,
  };
  return ctx;
}

function applyPlugin(ctx: ReturnType<typeof fakeCtx>): void {
  handlers.clear();
  pushes.length = 0;
  plugin.apply(ctx, { url: "ws://x", runtimeId: "rt-1", token: "t" });
}

/** Run `run` with a switch that fires the plugin's grace timer by hand. */
async function withCapturedGraceTimer(run: (fireGrace: () => void) => Promise<void>): Promise<void> {
  const original = globalThis.setTimeout;
  let fireGrace: (() => void) | null = null;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
    fireGrace = () => fn();
    // A real, Immediately-expired timer stands in for the armed one, so the
    // plugin's later clearTimeout still clears a genuine handle.
    return original(() => {}, 0);
  }) as typeof setTimeout;
  try {
    await run(() => {
      if (fireGrace === null) throw new Error("no grace timer was armed");
      fireGrace();
    });
  } finally {
    globalThis.setTimeout = original;
  }
}

/** Run `run` once with process.stderr.write captured, then restore it. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("");
}

describe("suite_reply", () => {
  test("resolves ok when no error event arrives within the grace window", async () => {
    const registered: any[] = [];
    const ctx = fakeCtx({ tools: (def) => void registered.push(def) });
    applyPlugin(ctx);
    const tool = registered.find((t) => t.name === "suite_reply");
    expect(tool).toBeDefined();

    await withCapturedGraceTimer(async (fireGrace) => {
      const pending = tool.execute({ space_id: "sp-1", content: "hello" });
      fireGrace();
      expect(await pending).toEqual({ ok: true, space_id: "sp-1" });
    });
    // The message itself was pushed on the channel — waiting out the grace
    // window is about the JUDGEMENT, not about delaying the send.
    expect(pushes.some((p) => p.event === "reply" && p.payload.space_id === "sp-1" && p.payload.content === "hello")).toBe(true);
  });

  test("resolves ok:false with the error detail when an error event arrives", async () => {
    const registered: any[] = [];
    const ctx = fakeCtx({ tools: (def) => void registered.push(def) });
    applyPlugin(ctx);
    const tool = registered.find((t) => t.name === "suite_reply");

    await withCapturedGraceTimer(async () => {
      const pending = tool.execute({ space_id: "sp-1", content: "hello" });
      // Refusals arrive as a separate `error` EVENT pushed immediately —
      // never as an ack to the `reply` push itself, which the channel does
      // not answer.
      handlers.get("error")!({ error: "you are not a participant" });
      expect(await pending).toEqual({ ok: false, error: "you are not a participant" });
    });

    // A string payload is the ordinary shape; anything else is stringified
    // rather than dropped, because "ok:false, unknown error" hides the one
    // thing an operator needs.
    await withCapturedGraceTimer(async () => {
      const pending = tool.execute({ space_id: "sp-2", content: "again" });
      handlers.get("error")!({ reason: { code: 12 } });
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("code");
    });
  });

  test("a build with no tools service mounts the plugin with no send path", () => {
    const stderr = captureStderr(() => {
      const ctx = fakeCtx();
      expect(() => applyPlugin(ctx)).not.toThrow();
    });
    // The nested inject simply never fires: an optional dependency that never
    // mounts leaves its fiber inactive, and there is nothing to log. The
    // plugin mounts without a send path and without any error.
    expect(stderr).not.toContain("TOOL-REGISTER-FAILED");
    // Federation survived: the dispatch handler is still wired.
    expect(handlers.has("attention")).toBe(true);
  });

  test("a throwing register is logged and skipped, not fatal", () => {
    const stderr = captureStderr(() => {
      const ctx = fakeCtx({ tools: () => {
        throw new Error("boom");
      } });
      expect(() => applyPlugin(ctx)).not.toThrow();
    });
    expect(stderr).toContain("TOOL-REGISTER-FAILED");
    expect(stderr).toContain("boom");
    expect(handlers.has("attention")).toBe(true);
  });
});

describe("plugin inject requirements", () => {
  test("plugin.inject no longer requires tools", () => {
    // The `tools` service is now OPTIONAL: it lives in a nested
    // `ctx.inject(['tools'], ...)` rather than the plugin's own top-level
    // `inject` array. Cordis holds a plugin inactive until every service in
    // its own inject mounts, so declaring `tools` there would suspend the
    // whole plugin — dispatches, queued turns, usage reports — on builds
    // that never mount a tools service. Nested, only the nested fiber waits.
    expect(plugin.inject).not.toContain("tools");
  });
});

describe("queued typing", () => {
  test("a dispatch queued behind a running turn pushes typing for its space", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = fakeCtx({ turnGate: gate });
    applyPlugin(ctx);

    // Turn 1 starts and blocks inside whenIdle, holding the space inflight.
    const first = captureStderr(() =>
      handlers.get("attention")!({ signal: { space_id: "space-q", message_id: "m1" } }),
    );
    expect(first).not.toContain("QUEUED");

    const before = pushes.length;
    // Turn 2 arrives while turn 1 still holds the space. Queued — and typing,
    // so the reader sees "queued", not silence that reads as "dropped".
    const second = captureStderr(() =>
      handlers.get("attention")!({ signal: { space_id: "space-q", message_id: "m2" } }),
    );
    expect(second).toContain("QUEUED space=space-q depth=1");
    const queuedTyping = pushes
      .slice(before)
      .filter((p) => p.event === "typing" && p.payload.space_id === "space-q" && p.payload.typing === true);
    expect(queuedTyping).toHaveLength(1);

    // Let both turns finish so the test does not leak a pending turn.
    release();
    for (let i = 0; i < 300 && pushes.filter((p) => p.event === "reply").length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(pushes.filter((p) => p.event === "reply")).toHaveLength(2);
  });
});

describe("live tool trace", () => {
  test("tool/call and tool/result events are traced to stderr", () => {
    const ctx = fakeCtx();
    applyPlugin(ctx);
    const onEvent = ctx.listeners.get("session/event");
    expect(onEvent).toBeTypeOf("function");

    const call = captureStderr(() =>
      onEvent!(undefined, {
        type: "tool/call",
        data: { name: "Bash", arguments: "cmd ".repeat(50) },
      }),
    );
    // Truncated: the shape of the work, not its contents.
    expect(call).toContain("[suite-federation] TOOL Bash");
    expect(call).toContain("…");

    const result = captureStderr(() =>
      onEvent!(undefined, {
        type: "tool/result",
        data: { message: { content: [{ type: "text", text: "output" }] } },
      }),
    );
    // Only the size — echoing the payload would bury the trace.
    expect(result).toMatch(/TOOL-RESULT \d+b/);
  });

  test("a malformed session/event cannot disturb the turn", () => {
    const ctx = fakeCtx();
    applyPlugin(ctx);
    const onEvent = ctx.listeners.get("session/event")!;
    // The trace is a passenger on the agent's turn; any of its own failures
    // must surface as a missing log line, never as a thrown error.
    expect(() => onEvent(undefined, undefined)).not.toThrow();
    expect(() => onEvent(undefined, { type: "tool/call", data: undefined })).not.toThrow();
  });
});

describe("composition with a real cordis Context", () => {
  /** Provide the services the plugin's own top-level inject requires. */
  function provideRequiredServices(ctx: Context) {
    ctx.provide("agents", {
      create: async () => ({
        agent: {
          session: { id: "session-x", seq: 0, events: [] as any[] },
          followup() {},
          whenIdle: async () => {},
        },
      }),
    });
    ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) });
    ctx.provide("sessions", { flush: async () => {} });
  }

  /** Let child fibers (the nested `ctx.inject`) settle before asserting. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  test("activates with no tools service mounted — federation survives, suite_reply does not", async () => {
    handlers.clear();
    pushes.length = 0;
    const ctx = new Context();
    provideRequiredServices(ctx);
    // NO tools service exists at all. The nested `ctx.inject(['tools'], ...)`
    // must simply never fire, while the plugin itself still activates.

    const registered: any[] = [];
    await ctx.plugin(plugin, { url: "ws://x", runtimeId: "rt-1", token: "t" });
    await settle();

    // The plugin ACTIVATED: apply ran and joined the channel.
    expect(handlers.has("attention")).toBe(true);
    // The nested inject never fired, so nothing registered a tool.
    expect(registered).toHaveLength(0);
  });

  test("registers suite_reply once a tools service mounts", async () => {
    handlers.clear();
    pushes.length = 0;
    const ctx = new Context();
    provideRequiredServices(ctx);
    const registered: any[] = [];
    ctx.provide("tools", {
      register: (def: any) => {
        registered.push(def);
        return () => {};
      },
    });

    await ctx.plugin(plugin, { url: "ws://x", runtimeId: "rt-1", token: "t" });
    await settle();

    // The nested inject fired and registered the tool through the stub.
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("suite_reply");

    // The tool is live through the channel contract: a `reply` push carries
    // the space and the message body.
    handlers.get("attention")!({ signal: { space_id: "space-x", message_id: "m1" } });
    const tool = registered[0];
    await withCapturedGraceTimer(async (fireGrace) => {
      const pending = tool.execute({ space_id: "space-x", content: "hello from composition" });
      fireGrace();
      expect(await pending).toEqual({ ok: true, space_id: "space-x" });
    });
    expect(pushes.some((p) => p.event === "reply" && p.payload.space_id === "space-x")).toBe(true);
  });
});
