/**
 * The structured operations a Burrow install can ask of this machine over
 * `runtime_host:<runtime_id>`: file.list, file.read, file.write, secret.set.
 * Nothing here touches a terminal, a tmux pane or a process.
 *
 * ATOMIC WRITE, in order, under a per-path lock:
 *   1. hash the current bytes; if they differ from `expected_sha256` (or the
 *      file exists and `expected_sha256` is null), answer a conflict;
 *   2. write a temp file in the SAME directory (O_EXCL|O_NOFOLLOW), fsync it;
 *   3. hash the target again immediately before the rename; if it changed since
 *      step 1, remove the temp file and answer a conflict;
 *   4. rename over the target, fsync the directory.
 * REMAINING WINDOW: a writer that is not this process can still change the
 * target between step 3 and step 4 (microseconds: a hash of a file of at most
 * 512 KiB is the last thing before rename(2)). The lock only orders requests
 * made through this host. The change is then lost to the rename, not merged.
 * Closing that window needs a rename-with-precondition the OS does not offer.
 *
 * REDACTION. Reads show names, never values (redact.ts); the precondition hash
 * is over the FULL on-disk bytes, so a client that cannot see a secret can
 * still detect that the file changed. A write of a redacted file keeps the
 * values that are on disk.
 */
import { closeSync, constants, fsyncSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, fstatSync, mkdirSync, readdirSync, lstatSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { permits, type ConfigAccess } from "./access.ts";
import { MAX_FILE_BYTES, scope } from "./scope.ts";
import { isSecretBearing, isSecretFile, putSecret, redactForRead, restore } from "./redact.ts";

export type Reply = { ok: Record<string, unknown> } | { error: string };

export interface OpsOptions {
  /** The agent folder. */
  root: string;
  /** Read per request, so `burrow config-access` takes effect without a restart. */
  access(): ConfigAccess;
  /**
   * Where Codex keeps its config for this folder: null for the default
   * `<root>/.codex`. A path outside the root makes the `.codex/` paths
   * unavailable instead of followed.
   */
  codexHome?(): string | null;
  /** Test seam: runs after the temp file is written and fsynced, before the re-hash. */
  beforeRehash?(path: string): void;
  /** Test seam: runs between the first hash and the temp-file write. */
  afterFirstHash?(path: string): void;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Config paths `file.list` reports, by glob. A folder is a work tree: nothing else is listed. */
const LIST_FIXED = ["CLAUDE.md", "AGENTS.md", ".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/.credentials.json", ".codex/config.toml", ".codex/auth.json"];
const LIST_DIRS: { dir: string; file: RegExp; sub?: string }[] = [
  { dir: ".claude/skills", file: /^SKILL\.md$/, sub: "dir" },
  { dir: ".claude/agents", file: /\.md$/ },
  { dir: ".claude/commands", file: /\.md$/ },
  { dir: ".codex/skills", file: /^SKILL\.md$/, sub: "dir" },
];

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function readBounded(full: string): Buffer | "too_large" {
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a file");
    if (st.size > MAX_FILE_BYTES) return "too_large";
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n === 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

export class HostOps {
  constructor(private readonly o: OpsOptions) {}

  /** Handle one request. `null` means: say nothing (the opt-in is off). */
  async handle(event: string, payload: Record<string, unknown>): Promise<Reply | null> {
    const access = this.o.access();
    if (access === "off") return null;
    if (!permits(access, payload["actor_role"])) return { error: "forbidden" };
    try {
      switch (event) {
        case "file.list":
          return this.list();
        case "file.read":
          return this.read(payload["path"]);
        case "file.write":
          return await this.write(payload["path"], payload["content"], payload["expected_sha256"]);
        case "secret.set":
          return await this.secretSet(payload["path"], payload["pointer"], payload["value"]);
        default:
          return { error: "unsupported" };
      }
    } catch (e) {
      // Never echo a message: it could carry a path or, worse, a value.
      void e;
      return { error: "failed" };
    }
  }

  /** True for a `.codex/` path when Codex is homed somewhere other than `<root>/.codex`. */
  private unavailable(rel: string): boolean {
    if (!rel.startsWith(".codex/")) return false;
    const home = this.o.codexHome?.() ?? null;
    if (home === null) return false;
    let real = home;
    try {
      real = realpathSync(home);
    } catch {
      /* a home that does not exist yet is compared as written */
    }
    let root = this.o.root;
    try {
      root = realpathSync(root);
    } catch {
      /* compared as written */
    }
    return real !== join(root, ".codex");
  }

  private list(): Reply {
    const entries: { path: string; sha256: string; secret: boolean }[] = [];
    const add = (rel: string) => {
      if (this.unavailable(rel)) return;
      const s = scope(this.o.root, rel);
      if (!s.ok || !s.exists) return;
      try {
        const bytes = readBounded(s.full);
        if (bytes === "too_large") return;
        entries.push({ path: rel, sha256: sha256(bytes), secret: isSecretFile(rel) });
      } catch {
        /* unreadable: not listed */
      }
    };
    for (const rel of LIST_FIXED) add(rel);
    for (const name of safeDir(this.o.root)) if (name.startsWith(".env")) add(name);
    for (const d of LIST_DIRS) {
      for (const name of safeDir(join(this.o.root, d.dir))) {
        if (d.sub === "dir") add(`${d.dir}/${name}/SKILL.md`);
        else if (d.file.test(name)) add(`${d.dir}/${name}`);
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { ok: { entries } };
  }

  private read(path: unknown): Reply {
    const s = scope(this.o.root, path);
    if (!s.ok) return { error: s.reason };
    if (this.unavailable(s.rel)) return { error: "unavailable" };
    if (!s.exists) return { error: "not_found" };
    const bytes = readBounded(s.full);
    if (bytes === "too_large") return { error: "too_large" };
    const text = bytes.toString("utf8");
    const { shown } = redactForRead(s.rel, text);
    return { ok: { content: shown, sha256: sha256(bytes) } };
  }

  private write(path: unknown, content: unknown, expected: unknown): Promise<Reply> | Reply {
    const s = scope(this.o.root, path);
    if (!s.ok) return { error: s.reason };
    if (typeof content !== "string") return { error: "invalid_content" };
    if (expected !== null && expected !== undefined && typeof expected !== "string") return { error: "invalid_expected" };
    if (isSecretFile(s.rel)) return { error: "secret_path" };
    if (this.unavailable(s.rel)) return { error: "unavailable" };
    return this.commit(s.rel, s.full, (current) => {
      const r = restore(s.rel, content, current);
      return r.ok ? { ok: true, content: r.content } : r;
    }, (expected ?? null) as string | null);
  }

  private secretSet(path: unknown, pointer: unknown, value: unknown): Promise<Reply> | Reply {
    const s = scope(this.o.root, path);
    if (!s.ok) return { error: s.reason };
    if (typeof pointer !== "string" || typeof value !== "string") return { error: "invalid" };
    if (!isSecretFile(s.rel) && !isSecretBearing(s.rel)) return { error: "not_a_secret_file" };
    if (this.unavailable(s.rel)) return { error: "unavailable" };
    return this.commit(s.rel, s.full, (current) => putSecret(s.rel, current, pointer, value), "any");
  }

  /** The locked read-hash-write-rehash-rename sequence. `expected` "any" skips the precondition. */
  private commit(
    rel: string,
    full: string,
    build: (current: string | null) => { ok: true; content: string } | { ok: false; reason: string },
    expected: string | null | "any",
  ): Promise<Reply> {
    return withLock(full, (): Reply => {
      let currentBytes: Buffer | null = null;
      const first = scope(this.o.root, rel);
      if (!first.ok) return { error: first.reason };
      if (first.exists) {
        const b = readBounded(first.full);
        if (b === "too_large") return { error: "too_large" };
        currentBytes = b;
      }
      const currentSha = currentBytes === null ? null : sha256(currentBytes);
      if (expected !== "any" && expected !== currentSha) return { ok: { status: "conflict", current_sha256: currentSha } };
      this.o.afterFirstHash?.(full);

      const built = build(currentBytes === null ? null : currentBytes.toString("utf8"));
      if (!built.ok) return { error: built.reason };
      const out = Buffer.from(built.content, "utf8");
      if (out.length > MAX_FILE_BYTES) return { error: "too_large" };

      mkdirSync(dirname(full), { recursive: true, mode: 0o755 });
      // The directory now exists: check the scope again before writing into it.
      const again = scope(this.o.root, rel);
      if (!again.ok) return { error: again.reason };

      const mode = isSecretFile(rel) || isSecretBearing(rel) ? 0o600 : 0o644;
      const tmp = join(dirname(full), `.${rel.split("/").pop()}.${randomBytes(6).toString("hex")}.tmp`);
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      try {
        let at = 0;
        while (at < out.length) at += writeSync(fd, out, at, out.length - at);
        fsyncSync(fd);
      } catch (e) {
        closeSync(fd);
        unlinkSync(tmp);
        throw e;
      }
      closeSync(fd);

      this.o.beforeRehash?.(full);
      // Re-hash immediately before the rename.
      let nowSha: string | null = null;
      try {
        const b = readBounded(full);
        nowSha = b === "too_large" ? "too_large" : sha256(b);
      } catch {
        nowSha = null;
      }
      if (nowSha !== currentSha) {
        unlinkSync(tmp);
        return { ok: { status: "conflict", current_sha256: nowSha } };
      }
      renameSync(tmp, full);
      try {
        const dfd = openSync(dirname(full), constants.O_RDONLY);
        fsyncSync(dfd);
        closeSync(dfd);
      } catch {
        /* a directory fsync is best effort */
      }
      return { ok: { status: "ok", sha256: sha256(out) } };
    });
  }
}

function safeDir(dir: string): string[] {
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
    return readdirSync(dir).filter((n) => !n.includes("/") && n !== "." && n !== "..");
  } catch {
    return [];
  }
}
