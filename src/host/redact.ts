/**
 * Redaction ON THE MACHINE: a secret value never leaves it in a read.
 *
 * - A secret file (`.env*`, `*credentials.json`, `.claude/.credentials.json`,
 *   `.codex/auth.json`) shows NAMES only, one per line.
 * - A secret-bearing file (`.mcp.json`, `.claude/settings*.json`,
 *   `.codex/config.toml`) keeps its shape; values of `env`, `headers`,
 *   `http_headers` and `bearer_token` become `[redacted]`. A `${NAME}`
 *   reference to the environment is not a value and stays.
 * - Everything else is shown as stored.
 *
 * The TOML handling is line based on purpose: it keeps comments and key order,
 * so saving a config.toml does not reformat the user's file.
 *
 * A write of a redacted file carries `[redacted]` where a value was; {@link restore}
 * puts the on-disk value back, and refuses a placeholder with no counterpart.
 */
export const REDACTED = "[redacted]";
const ENV_REF = /^\$\{[A-Za-z0-9_]+\}$/;

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isSecretFile(path: string): boolean {
  const base = baseName(path);
  return base.startsWith(".env") || base.endsWith("credentials.json") || path === ".claude/.credentials.json" || path === ".codex/auth.json";
}

export function isSecretBearing(path: string): boolean {
  const base = baseName(path);
  return path === ".mcp.json" || (path.startsWith(".claude/") && /^settings.*\.json$/.test(base)) || path === ".codex/config.toml";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function leafNames(value: unknown, prefix: string[]): string[] {
  if (!isPlainObject(value)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (isPlainObject(v)) out.push(...leafNames(v, [...prefix, k]));
    else out.push([...prefix, k].join("."));
  }
  return out;
}

/** The names a secret file holds, sorted, unique. */
export function secretNames(path: string, content: string): string[] {
  let names: string[] = [];
  if (path.endsWith(".json")) {
    try {
      names = leafNames(JSON.parse(content), []);
    } catch {
      names = [];
    }
  } else {
    names = [...content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1] ?? "");
  }
  return [...new Set(names)].sort();
}

// ---- JSON ----------------------------------------------------------------

function scrubMap(holder: unknown, field: string, names: string[]): void {
  if (!isPlainObject(holder)) return;
  const map = holder[field];
  if (!isPlainObject(map)) return;
  for (const [k, v] of Object.entries(map)) {
    if (!(typeof v === "string" && ENV_REF.test(v)) && v !== REDACTED) {
      map[k] = REDACTED;
      names.push(k);
    }
  }
}

function redactJson(content: string): { shown: string; names: string[] } {
  try {
    const doc = JSON.parse(content) as unknown;
    if (!isPlainObject(doc)) return { shown: "[unparseable file not shown]\n", names: [] };
    const names: string[] = [];
    scrubMap(doc, "env", names);
    const servers = doc["mcpServers"];
    if (isPlainObject(servers)) {
      for (const s of Object.values(servers)) {
        scrubMap(s, "env", names);
        scrubMap(s, "headers", names);
      }
    }
    return { shown: `${JSON.stringify(doc, null, 2)}\n`, names };
  } catch {
    return { shown: "[unparseable file not shown]\n", names: [] };
  }
}

// ---- TOML (line based) ---------------------------------------------------

interface TomlLine {
  index: number;
  table: string;
  key: string;
}

const TABLE = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;
const KEYVAL = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"]*"))(\s*=\s*)(.*)$/;
const SECRET_KEYS = new Set(["bearer_token", "experimental_bearer_token"]);

function tableIsSecret(table: string): boolean {
  return /(^|\.)(env|http_headers)$/.test(table);
}

/** Every `key = value` line with the table it sits in. */
function scanToml(lines: string[]): TomlLine[] {
  const out: TomlLine[] = [];
  let table = "";
  lines.forEach((line, index) => {
    const t = TABLE.exec(line);
    if (t !== null) {
      table = (t[1] ?? "").trim();
      return;
    }
    const kv = KEYVAL.exec(line);
    if (kv !== null) out.push({ index, table, key: (kv[2] ?? "").replace(/^"|"$/g, "") });
  });
  return out;
}

const INLINE_ENTRY = /((?:[A-Za-z0-9_-]+|"[^"]*")\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g;

function redactToml(content: string): { shown: string; names: string[] } {
  const lines = content.split("\n");
  const names: string[] = [];
  for (const l of scanToml(lines)) {
    const kv = KEYVAL.exec(lines[l.index] ?? "");
    if (kv === null) continue;
    const [, indent, rawKey, eq, value] = kv as unknown as string[];
    const secretTable = tableIsSecret(l.table);
    if (secretTable || SECRET_KEYS.has(l.key)) {
      if ((value ?? "").trim() !== `"${REDACTED}"`) names.push(l.key);
      lines[l.index] = `${indent}${rawKey}${eq}"${REDACTED}"`;
    } else if ((l.key === "env" || l.key === "http_headers") && (value ?? "").trim().startsWith("{")) {
      lines[l.index] = `${indent}${rawKey}${eq}${(value ?? "").replace(INLINE_ENTRY, (_m, head: string, v: string) => {
        const name = /^"?([^"=\s]+)"?/.exec(head)?.[1] ?? "";
        if (v.slice(1, -1) !== REDACTED) names.push(name);
        return `${head}"${REDACTED}"`;
      })}`;
    }
  }
  return { shown: lines.join("\n"), names };
}

// ---- public --------------------------------------------------------------

/** What a read may show for `path`, and the secret names it hid. */
export function redactForRead(path: string, content: string): { shown: string; names: string[] } {
  if (isSecretFile(path)) {
    const names = secretNames(path, content);
    return { shown: names.map((n) => `${n}\n`).join(""), names };
  }
  if (isSecretBearing(path)) {
    const r = path.endsWith(".toml") ? redactToml(content) : redactJson(content);
    return { shown: r.shown, names: [...new Set(r.names)].sort() };
  }
  return { shown: content, names: [] };
}

export type RestoreResult = { ok: true; content: string } | { ok: false; reason: string };

function restoreJsonValue(next: unknown, old: unknown): { ok: true; value: unknown } | { ok: false } {
  if (next === REDACTED) return old === undefined ? { ok: false } : { ok: true, value: old };
  if (isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      const r = restoreJsonValue(v, isPlainObject(old) ? old[k] : undefined);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value: next };
}

/**
 * Put the on-disk values back where `next` carries `[redacted]`. `old` is the
 * current file (null when there is none).
 */
export function restore(path: string, next: string, old: string | null): RestoreResult {
  if (!next.includes(REDACTED)) return { ok: true, content: next };
  if (path.endsWith(".json")) {
    let n: unknown;
    let o: unknown = {};
    try {
      n = JSON.parse(next);
      if (old !== null) o = JSON.parse(old);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    const r = restoreJsonValue(n, o);
    return r.ok ? { ok: true, content: `${JSON.stringify(r.value, null, 2)}\n` } : { ok: false, reason: "unresolved_redaction" };
  }
  // TOML: line by line, matched on (table, key).
  const oldLines = (old ?? "").split("\n");
  const oldByKey = new Map<string, string>();
  for (const l of scanToml(oldLines)) oldByKey.set(`${l.table}\0${l.key}`, oldLines[l.index] ?? "");
  const lines = next.split("\n");
  for (const l of scanToml(lines)) {
    const line = lines[l.index] ?? "";
    if (!line.includes(REDACTED)) continue;
    if (/^\s*[A-Za-z0-9_"-]+\s*=\s*\{/.test(line)) {
      // inline table: restore each redacted entry from the old inline table
      const oldLine = oldByKey.get(`${l.table}\0${l.key}`);
      if (oldLine === undefined) return { ok: false, reason: "unresolved_redaction" };
      const oldEntries = new Map<string, string>();
      for (const m of oldLine.matchAll(INLINE_ENTRY)) oldEntries.set((m[1] ?? "").replace(/\s*=\s*$/, "").replace(/^"|"$/g, ""), m[2] ?? "");
      let missing = false;
      lines[l.index] = line.replace(INLINE_ENTRY, (m: string, head: string, v: string) => {
        if (v.slice(1, -1) !== REDACTED) return m;
        const old1 = oldEntries.get(head.replace(/\s*=\s*$/, "").replace(/^"|"$/g, ""));
        if (old1 === undefined) {
          missing = true;
          return m;
        }
        return `${head}${old1}`;
      });
      if (missing) return { ok: false, reason: "unresolved_redaction" };
      continue;
    }
    const oldLine = oldByKey.get(`${l.table}\0${l.key}`);
    if (oldLine === undefined) return { ok: false, reason: "unresolved_redaction" };
    const oldKv = KEYVAL.exec(oldLine);
    const kv = KEYVAL.exec(line);
    if (oldKv === null || kv === null) return { ok: false, reason: "unresolved_redaction" };
    lines[l.index] = `${kv[1]}${kv[2]}${kv[3]}${oldKv[4]}`;
  }
  return { ok: true, content: lines.join("\n") };
}

/** A TOML string literal. */
function tomlString(v: string): string {
  return JSON.stringify(v);
}

/**
 * Merge ONE secret `value` into `content` (null for a new file) at `pointer`:
 * a variable name for an env file, a `/`-separated path for JSON or TOML.
 * Write-only: the value is in the returned bytes and nowhere else.
 */
export function putSecret(path: string, content: string | null, pointer: string, value: string): RestoreResult {
  if (value === "" || Buffer.byteLength(value, "utf8") > 4096) return { ok: false, reason: "invalid_value" };
  if (baseName(path).startsWith(".env")) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pointer)) return { ok: false, reason: "invalid_pointer" };
    if (/[\n\r\0]/.test(value)) return { ok: false, reason: "invalid_value" };
    const lines = (content ?? "").split("\n");
    const re = new RegExp(`^\\s*(?:export\\s+)?${pointer}\\s*=`);
    let found = false;
    const out = lines.map((l) => {
      if (re.test(l)) {
        found = true;
        return `${pointer}=${value}`;
      }
      return l;
    });
    const kept = found ? out : [...out.filter((l) => l !== ""), `${pointer}=${value}`];
    return { ok: true, content: `${kept.join("\n").replace(/\n+$/, "")}\n` };
  }
  const segments = pointer.split("/").filter((s) => s !== "");
  if (segments.length === 0) return { ok: false, reason: "invalid_pointer" };
  if (path.endsWith(".json")) {
    let doc: unknown = {};
    try {
      if (content !== null) doc = JSON.parse(content);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    if (!isPlainObject(doc)) return { ok: false, reason: "invalid_json" };
    let at: Record<string, unknown> = doc;
    for (const seg of segments.slice(0, -1)) {
      const child = at[seg];
      if (isPlainObject(child)) at = child;
      else {
        const fresh: Record<string, unknown> = {};
        at[seg] = fresh;
        at = fresh;
      }
    }
    at[segments[segments.length - 1] as string] = value;
    return { ok: true, content: `${JSON.stringify(doc, null, 2)}\n` };
  }
  if (path.endsWith(".toml")) {
    const key = segments[segments.length - 1] as string;
    const table = segments.slice(0, -1).join(".");
    if (!/^[A-Za-z0-9_-]+$/.test(key) || !segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return { ok: false, reason: "invalid_pointer" };
    const lines = (content ?? "").split("\n");
    for (const l of scanToml(lines)) {
      if (l.table === table && l.key === key) {
        const kv = KEYVAL.exec(lines[l.index] ?? "");
        if (kv !== null) lines[l.index] = `${kv[1]}${kv[2]}${kv[3]}${tomlString(value)}`;
        return { ok: true, content: lines.join("\n") };
      }
    }
    const header = lines.findIndex((l) => {
      const t = TABLE.exec(l);
      return t !== null && (t[1] ?? "").trim() === table;
    });
    const entry = `${key} = ${tomlString(value)}`;
    if (table === "") {
      const firstTable = lines.findIndex((l) => TABLE.test(l));
      lines.splice(firstTable === -1 ? lines.length : firstTable, 0, entry);
      return { ok: true, content: `${lines.join("\n").replace(/\n+$/, "")}\n` };
    }
    if (header === -1) {
      const body = lines.join("\n").replace(/\n+$/, "");
      return { ok: true, content: `${body === "" ? "" : `${body}\n\n`}[${table}]\n${entry}\n` };
    }
    lines.splice(header + 1, 0, entry);
    return { ok: true, content: lines.join("\n") };
  }
  return { ok: false, reason: "not_a_secret_file" };
}
