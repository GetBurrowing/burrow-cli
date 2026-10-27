/**
 * THE TOOL SNAPSHOT: which external MCP tools the harness in this folder loads
 * (task 01a17b1c stage 4). Taken before and after a session restart so the
 * Burrow install can show "Tools A → B: +x, -y".
 *
 * Burrow's OWN tools are not probed here: core computes them from the tool
 * surface it serves this runtime. This module covers only the servers the
 * harness itself starts:
 *
 *   claude_code  `.mcp.json` servers that are APPROVED (named in
 *                `enabledMcpjsonServers`, or `enableAllProjectMcpServers`, in
 *                `.claude/settings.json` / `.claude/settings.local.json`, and
 *                not in `disabledMcpjsonServers`). An unapproved server is
 *                skipped by Claude on launch (burrow-cli answers the "new MCP
 *                server" dialog with "continue without"), so it is not loaded
 *                and not listed.
 *   codex        `[mcp_servers.<name>]` in `.codex/config.toml`, except
 *                `enabled = false`. Burrow's own servers are passed as `-c`
 *                overrides and are never in the file.
 *
 * Each server gets `tools/list` with a short timeout. A server that does not
 * answer is reported as `unreachable:<server>`, never dropped.
 *
 * SECRETS. env and header VALUES are read from disk to start the server, as the
 * harness would, and go nowhere else: the snapshot holds server names, tool
 * names and a status. Nothing a server prints on stderr is kept, and a tool
 * name that contains one of the server's secret values is replaced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { REDACTED } from "./redact.ts";

export interface McpServerSpec {
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface ServerSnapshot {
  name: string;
  status: "ok" | "unreachable";
  tools: string[];
}

export interface ToolSnapshot {
  taken_at: string;
  servers: ServerSnapshot[];
  /** Flat and sorted: `<server>/<tool>` for each tool, `unreachable:<server>` for each failed probe. */
  tools: string[];
}

export const PROBE_TIMEOUT_MS = 5_000;

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Json)) if (typeof x === "string") out[k] = x;
  }
  return out;
};

function specOf(name: string, raw: unknown, headerKey: "headers" | "http_headers"): McpServerSpec | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Json;
  const spec: McpServerSpec = { name, args: strings(r["args"]), env: stringMap(r["env"]), headers: stringMap(r[headerKey]) };
  if (typeof r["command"] === "string" && r["command"] !== "") spec.command = r["command"];
  else if (typeof r["url"] === "string" && r["url"] !== "") spec.url = r["url"];
  else return null;
  if (headerKey === "http_headers" && typeof r["bearer_token"] === "string") spec.headers["Authorization"] = `Bearer ${r["bearer_token"]}`;
  return spec;
}

/** The external MCP servers Claude Code loads in `root`. */
export function claudeServers(root: string): McpServerSpec[] {
  const mcp = readJson(join(root, ".mcp.json"));
  const servers = (mcp?.["mcpServers"] ?? {}) as Json;
  const settings = [readJson(join(root, ".claude/settings.json")), readJson(join(root, ".claude/settings.local.json"))];
  const enabled = new Set(settings.flatMap((s) => strings(s?.["enabledMcpjsonServers"])));
  const disabled = new Set(settings.flatMap((s) => strings(s?.["disabledMcpjsonServers"])));
  const all = settings.some((s) => s?.["enableAllProjectMcpServers"] === true);
  const out: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (disabled.has(name) || !(all || enabled.has(name))) continue;
    const s = specOf(name, raw, "headers");
    if (s !== null) out.push(s);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The MCP servers Codex loads from `<root>/.codex/config.toml`. */
export function codexServers(root: string): McpServerSpec[] {
  let doc: Json;
  try {
    doc = Bun.TOML.parse(readFileSync(join(root, ".codex/config.toml"), "utf8")) as Json;
  } catch {
    return [];
  }
  const servers = (doc["mcp_servers"] ?? {}) as Json;
  const out: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if ((raw as Json | null)?.["enabled"] === false) continue;
    const s = specOf(name, raw, "http_headers");
    if (s !== null) out.push(s);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function serversFor(harness: string, root: string): McpServerSpec[] {
  if (harness === "claude_code") return claudeServers(root);
  if (harness === "codex") return codexServers(root);
  return [];
}

/** `${VAR}` and `${VAR:-default}`, from the host's environment, as the harnesses expand them. */
export function expand(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, k: string, d: string | undefined) => env[k] ?? d ?? "");
}

const INIT = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "burrow-host", version: VERSION } },
});

function toolNames(result: unknown): { names: string[]; cursor: string | null } {
  const r = (result ?? {}) as Json;
  const names = Array.isArray(r["tools"]) ? (r["tools"] as Json[]).map((t) => t?.["name"]).filter((n): n is string => typeof n === "string") : [];
  return { names, cursor: typeof r["nextCursor"] === "string" ? r["nextCursor"] : null };
}

/** One stdio server: initialize, tools/list (following nextCursor), then kill it. */
async function probeStdio(spec: McpServerSpec, cwd: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<string[] | null> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  for (const [k, v] of Object.entries(spec.env)) childEnv[k] = expand(v, env);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([expand(spec.command!, env), ...spec.args.map((a) => expand(a, env))], {
      cwd,
      env: childEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const send = (msg: unknown) => {
    stdin.write(`${JSON.stringify(msg)}\n`);
    stdin.flush();
  };
  const pending = new Map<number, (v: Json) => void>();
  const pump = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        try {
          const msg = JSON.parse(line) as Json;
          if (typeof msg["id"] === "number") pending.get(msg["id"])?.(msg);
        } catch {
          /* not a JSON-RPC line */
        }
      }
    }
  })().catch(() => undefined);
  let nextId = 1;
  const call = (msg: (id: number) => Json) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send(msg(id));
    });
  const work = (async (): Promise<string[] | null> => {
    const init = await call(INIT);
    if (init["error"] !== undefined) return null;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const names: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await call((id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: cursor === null ? {} : { cursor } }));
      if (res["error"] !== undefined) return null;
      const t = toolNames(res["result"]);
      names.push(...t.names);
      cursor = t.cursor;
      if (cursor === null) break;
    }
    return names;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), timeoutMs);
  });
  const exited = proc.exited.then(() => null);
  try {
    return await Promise.race([work, timeout, exited.then(() => new Promise<null>((r) => setTimeout(() => r(null), 50)))]);
  } finally {
    clearTimeout(timer);
    try {
      stdin.end();
    } catch {
      /* already closed */
    }
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
    await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1_500))]);
    clearTimeout(killer);
    void pump;
  }
}

/** Parse a Streamable-HTTP response body: JSON, or SSE `data:` lines. */
function rpcBody(text: string): Json | null {
  try {
    return JSON.parse(text) as Json;
  } catch {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as Json;
        if (msg["id"] !== undefined) return msg;
      } catch {
        /* next line */
      }
    }
    return null;
  }
}

async function probeHttp(spec: McpServerSpec, env: Record<string, string | undefined>, timeoutMs: number): Promise<string[] | null> {
  const url = expand(spec.url!, env);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const [k, v] of Object.entries(spec.headers)) headers[k] = expand(v, env);
  const signal = AbortSignal.timeout(timeoutMs);
  const post = async (body: unknown): Promise<{ res: Response; msg: Json | null }> => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    const text = await res.text();
    return { res, msg: rpcBody(text) };
  };
  try {
    const init = await post(INIT(1));
    if (!init.res.ok || init.msg === null || init.msg["error"] !== undefined) return null;
    const sid = init.res.headers.get("mcp-session-id");
    if (sid !== null) headers["mcp-session-id"] = sid;
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).then((r) => r.text());
    const names: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r = await post({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor === null ? {} : { cursor } });
      if (!r.res.ok || r.msg === null || r.msg["error"] !== undefined) return null;
      const t = toolNames(r.msg["result"]);
      names.push(...t.names);
      cursor = t.cursor;
      if (cursor === null) break;
    }
    return names;
  } catch {
    return null;
  }
}

/** A tool name that carries one of the server's env or header values (12+ chars, so a short ordinary value such as a tool list does not trip it) is not shown. */
function scrub(spec: McpServerSpec, names: string[], env: Record<string, string | undefined>): string[] {
  const secrets = [...Object.values(spec.env), ...Object.values(spec.headers)].map((v) => expand(v, env)).filter((v) => v.length >= 12);
  return names.map((n) => (secrets.some((s) => n.includes(s)) ? REDACTED : n));
}

export interface SnapshotOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  now?(): Date;
}

/** Probe every server the harness in `root` loads, concurrently. */
export async function snapshotTools(harness: string, root: string, opts: SnapshotOptions = {}): Promise<ToolSnapshot> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const servers = await Promise.all(
    serversFor(harness, root).map(async (spec): Promise<ServerSnapshot> => {
      const names = spec.command !== undefined ? await probeStdio(spec, root, env, timeoutMs) : await probeHttp(spec, env, timeoutMs);
      if (names === null) return { name: spec.name, status: "unreachable", tools: [] };
      return { name: spec.name, status: "ok", tools: [...new Set(scrub(spec, names, env))].sort() };
    }),
  );
  return { taken_at: (opts.now?.() ?? new Date()).toISOString(), servers, tools: flatTools(servers) };
}

export function flatTools(servers: ServerSnapshot[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    if (s.status === "unreachable") out.push(`unreachable:${s.name}`);
    else for (const t of s.tools) out.push(`${s.name}/${t}`);
  }
  return out.sort();
}

export function diffTools(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((t) => !b.has(t)).sort(), removed: [...b].filter((t) => !a.has(t)).sort() };
}
