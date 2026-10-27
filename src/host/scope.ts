/**
 * Everything the host touches stays inside the agent folder.
 *
 * A request names a RELATIVE path. It is refused, before any file is opened, if
 * it is empty, absolute, `~`-relative, contains `..`, `.`, an empty or odd
 * component, a NUL or a backslash, or is more than {@link MAX_DEPTH} components.
 * Then the real path of its directory must stay inside the real path of the
 * root (a symlinked ancestor that leaves the root is refused), and the final
 * component must not be a symlink. Files are opened with O_NOFOLLOW.
 *
 * REMAINING WINDOW. Between the check and the open, an ancestor directory can
 * be swapped for a symlink by something running as the same user. O_NOFOLLOW
 * covers only the final component. The agent itself runs as this user, so this
 * guards against a mistaken or malicious request, not against the agent racing
 * its own folder; the root is the agent's own work tree, which it can already
 * write. Core's owner gate and the opt-in are what stand between a request and
 * this code.
 */
import { lstatSync, realpathSync } from "node:fs";
import { sep, join, dirname } from "node:path";

export const MAX_DEPTH = 4;
export const MAX_FILE_BYTES = 512 * 1024;
const COMPONENT = /^(?:[A-Za-z0-9_][A-Za-z0-9._@+-]*|\.[A-Za-z0-9_][A-Za-z0-9._@+-]*)$/;

export type Scoped = { ok: true; rel: string; full: string; exists: boolean } | { ok: false; reason: string };

/** True when `rel` is a path the host will consider at all. */
export function isRelativeKey(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "" || rel.length > 255) return false;
  if (rel.startsWith("/") || rel.startsWith("~")) return false;
  const parts = rel.split("/");
  return parts.length <= MAX_DEPTH && parts.every((p) => p !== "." && p !== ".." && COMPONENT.test(p));
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The nearest ancestor of `full` that exists, as a real path. */
function realExistingAncestor(full: string): string | null {
  let at = dirname(full);
  for (let i = 0; i < MAX_DEPTH + 2; i++) {
    try {
      return realpathSync(at);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}

export function scope(root: string, rel: unknown): Scoped {
  if (!isRelativeKey(rel)) return { ok: false, reason: "invalid_path" };
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: "root_unavailable" };
  }
  const full = join(realRoot, rel);
  const ancestor = realExistingAncestor(full);
  if (ancestor === null || !inside(realRoot, ancestor)) return { ok: false, reason: "outside_root" };
  let exists = false;
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!st.isFile()) return { ok: false, reason: "not_a_file" };
    exists = true;
  } catch {
    exists = false;
  }
  return { ok: true, rel, full, exists };
}
