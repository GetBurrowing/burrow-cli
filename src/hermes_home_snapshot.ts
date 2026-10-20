/**
 * A byte snapshot of the parts of a Hermes home that the start-time rename
 * (legacy_names.ts "Hermes") and the channel installer after it write, so a
 * start that fails part-way can put them back (hermes.ts `apply`, 0.12.1).
 *
 * WHAT IT COVERS, AND NOTHING ELSE. Restoring puts back:
 *   - config.yaml, .env, plugins/.install-metadata.json and every
 *     installs/<key>/facts.json that existed at snapshot time: their bytes,
 *     mode and mtime. One that did not exist is removed if it appeared.
 *     (facts.json names the dependency environment Hermes selects; Hermes
 *     rewrites it when `plugins remove` or `plugins install` commits a new one.)
 *   - the plugin trees plugins/<old>/ and plugins/<new>/ that existed, every
 *     file with its inode, bytes, mode and mtime (they are hard links), and
 *     every directory's mode and mtime. One that did not exist is removed.
 *   - the token file under its old and its new name, whichever existed, by
 *     rename(2) of a hard link: the same inode, bytes, mode and mtime. Its
 *     value never enters this process. One that did not exist is removed.
 * It does NOT restore what Hermes itself writes beside those as a side effect
 * of the same commands, MEASURED at hermes-agent fdec926e with the real
 * v0.3.1 -> v0.4.0 installers in a throwaway HERMES_HOME:
 *   - installs/<key>/environments/<id>/: `plugins remove` AND `plugins install`
 *     each committed a new dependency-environment generation; none was deleted.
 *     Restoring facts.json makes Hermes select the old generation again, which
 *     is still there; the new generations are left on disk.
 *   - backups/config/config.yaml.good.<timestamp>: Hermes writes one per
 *     config save and rotates the oldest out.
 *   - cache/ (uv), the lock files Hermes and the installer take, and the
 *     installer's .suite-channel/ record (written only when absent).
 *   - directory mtimes above the restored paths (HERMES_HOME, plugins/,
 *     mcp-tokens/, installs/<key>/).
 *
 * The snapshot itself is a directory inside HERMES_HOME (hard links need the
 * same filesystem), removed by {@link HermesHomeSnapshot.discard} and by a
 * complete restore; a restore that fails keeps it and names it.
 */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, relative } from "node:path";

interface FileRecord {
  path: string;
  bytes: Buffer | null;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

interface DirRecord {
  rel: string;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

interface TreeRecord {
  path: string;
  /** The hard-linked copy inside the snapshot, or null when the path did not exist. */
  copy: string | null;
  /** The path was a symlink: its target (Hermes's dev alias). */
  link?: string;
  dirs: DirRecord[];
}

interface TokenRecord {
  path: string;
  /** The hard link inside the snapshot, or null when the path did not exist. */
  copy: string | null;
  ino: number;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

export interface HermesHomeSnapshot {
  /** Where the snapshot is kept. */
  readonly dir: string;
  /** Put every covered path back. Returns one line per path that could not be restored; empty on success. */
  restore(): string[];
  /** Remove the snapshot (after a start that succeeded). */
  discard(): void;
}

export interface SnapshotPaths {
  /** Files restored by bytes, relative to HERMES_HOME. installs/<key>/facts.json is found by this module. */
  files: string[];
  /** Plugin trees, relative to HERMES_HOME. */
  trees: string[];
  /** Token files, relative to HERMES_HOME. */
  tokens: string[];
}

/** Times are kept as float milliseconds, so a restore keeps their sub-millisecond part. */
function setTimes(path: string, t: { atimeMs: number; mtimeMs: number }): void {
  utimesSync(path, t.atimeMs / 1000, t.mtimeMs / 1000);
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Every installs/<key>/facts.json present now, relative to HERMES_HOME. */
function factsFiles(home: string): string[] {
  const installs = join(home, "installs");
  if (!existsSync(installs)) return [];
  return readdirSync(installs)
    .map((k) => join("installs", k, "facts.json"))
    .filter((rel) => statOrNull(join(home, rel))?.isFile() === true);
}

/** Mirror `src` into `dst` as hard links (copies when a link is refused), recording each directory's mode and times. */
function linkTree(src: string, dst: string, dirs: DirRecord[], root: string): void {
  const st = lstatSync(src);
  mkdirSync(dst, { mode: 0o700 });
  dirs.push({ rel: relative(root, src), mode: st.mode & 0o7777, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const cst = lstatSync(s);
    if (cst.isDirectory()) linkTree(s, d, dirs, root);
    else if (cst.isSymbolicLink()) symlinkSync(readlinkSync(s), d);
    else {
      try {
        linkSync(s, d);
      } catch {
        copyFileSync(s, d);
        chmodSync(d, cst.mode & 0o7777);
        utimesSync(d, cst.atimeMs / 1000, cst.mtimeMs / 1000);
      }
    }
  }
}

/**
 * Take the snapshot. Throws before writing anything into the home except the
 * snapshot directory, which it removes again on failure: a start whose
 * snapshot cannot be taken changes nothing.
 */
export function snapshotHermesHome(home: string, paths: SnapshotPaths, now: () => number = Date.now): HermesHomeSnapshot {
  const dir = join(home, `.burrow-start-snapshot-${process.pid}-${now()}`);
  mkdirSync(dir, { mode: 0o700 });
  const files: FileRecord[] = [];
  const trees: TreeRecord[] = [];
  const tokens: TokenRecord[] = [];
  try {
    for (const rel of [...paths.files, ...factsFiles(home)]) {
      const path = join(home, rel);
      const st = statOrNull(path);
      if (st === null) files.push({ path, bytes: null, mode: 0, atimeMs: 0, mtimeMs: 0 });
      else files.push({ path, bytes: readFileSync(path), mode: st.mode & 0o7777, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
    }
    paths.trees.forEach((rel, i) => {
      const path = join(home, rel);
      const st = statOrNull(path);
      if (st === null) trees.push({ path, copy: null, dirs: [] });
      else if (st.isSymbolicLink()) trees.push({ path, copy: null, link: readlinkSync(path), dirs: [] });
      else {
        const copy = join(dir, `tree-${i}`);
        const dirs: DirRecord[] = [];
        linkTree(path, copy, dirs, path);
        trees.push({ path, copy, dirs });
      }
    });
    paths.tokens.forEach((rel, i) => {
      const path = join(home, rel);
      const st = statOrNull(path);
      if (st === null) {
        tokens.push({ path, copy: null, ino: 0, mode: 0, atimeMs: 0, mtimeMs: 0 });
        return;
      }
      const copy = join(dir, `token-${i}`);
      linkSync(path, copy);
      tokens.push({ path, copy, ino: st.ino, mode: st.mode & 0o7777, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const restore = (): string[] => {
    const failed: string[] = [];
    const attempt = (path: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        failed.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    for (const t of trees) {
      attempt(t.path, () => {
        rmSync(t.path, { recursive: true, force: true });
        if (t.link !== undefined) symlinkSync(t.link, t.path);
        else if (t.copy !== null) {
          mkdirSync(dirname(t.path), { recursive: true });
          renameSync(t.copy, t.path);
          // Deepest first, so setting a parent's mtime is the last write under it.
          for (const d of [...t.dirs].reverse()) {
            const p = join(t.path, d.rel);
            chmodSync(p, d.mode);
            setTimes(p, d);
          }
        }
      });
    }
    for (const f of files) {
      attempt(f.path, () => {
        if (f.bytes === null) {
          rmSync(f.path, { force: true });
          return;
        }
        // config.yaml is otherwise written only by Hermes (hermes.ts rule 3).
        // This puts back bytes Hermes itself wrote, replaced in one rename.
        const tmp = `${f.path}.burrow-restore-${process.pid}`;
        writeFileSync(tmp, f.bytes, { mode: 0o600 });
        chmodSync(tmp, f.mode);
        setTimes(tmp, f);
        renameSync(tmp, f.path);
      });
    }
    for (const t of tokens) {
      attempt(t.path, () => {
        if (t.copy === null) {
          rmSync(t.path, { force: true });
          return;
        }
        // Whether the rename moved it away or the installer replaced it, the
        // hard link holds the original inode: put it back under its name.
        mkdirSync(dirname(t.path), { recursive: true });
        renameSync(t.copy, t.path);
        chmodSync(t.path, t.mode);
        setTimes(t.path, t);
      });
    }
    if (failed.length === 0) rmSync(dir, { recursive: true, force: true });
    return failed;
  };

  return {
    dir,
    restore,
    discard: () => rmSync(dir, { recursive: true, force: true }),
  };
}
