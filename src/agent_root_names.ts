/**
 * The one-shot rename of an agent root's `suite` file names to `burrow` ones (0.10.2).
 *
 * Before 0.10.2 an agent root carried `suite.json`, `.suite-stamp.json`,
 * `.suite-state.json`, `.suite-codex/` and `.dsh/suite.patch.yml`. From 0.10.2
 * every verb reads and writes only the `burrow` names, and this module is the
 * ONLY place that spells the old ones. There is no dual read: a verb calls
 * {@link migrateAgentRoot} where it resolves the root, before it reads anything
 * in it, and the first 0.10.2 run in each root renames what is there.
 *
 * THE RULES, the same for every entry:
 *
 *  - old exists, new does not: `rename(2)` it. Same directory, so it is atomic
 *    and keeps the mode and the owner (`.burrow-state.json` stays 0600).
 *  - both exist: refuse, naming both paths, and rename NOTHING. Every entry is
 *    checked before any is moved, so a refusal leaves the root as it was.
 *  - only new, or neither: nothing to do.
 *
 * The stamp record survives the rename unchanged: its inputs digest covers the
 * harness, writer version, Burrow URL, runtime id, token ref and the verb's
 * non-secret inputs, and none of those names a file in the root.
 */
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";

/** `[old, new]`, relative to the agent root. */
export const AGENT_ROOT_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["suite.json", "burrow.json"],
  [".suite-stamp.json", ".burrow-stamp.json"],
  [".suite-state.json", ".burrow-state.json"],
  [".suite-codex", ".burrow-codex"],
  [join(".dsh", "suite.patch.yml"), join(".dsh", "burrow.patch.yml")],
];

export class AgentRootConflict extends Error {
  constructor(
    readonly oldPath: string,
    readonly newPath: string,
  ) {
    super(
      `${oldPath} and ${newPath} both exist; burrow 0.10.2 reads only ${newPath}, ` +
        `so keep one (move the other aside) and run again`,
    );
    this.name = "AgentRootConflict";
  }
}

export interface RootRename {
  from: string;
  to: string;
}

/** Present without following a symlink: a dangling link still holds the name. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` holds the pre-0.10.2 identity file, i.e. is an unmigrated agent root. */
export function holdsLegacyIdentity(dir: string): boolean {
  return present(join(dir, (AGENT_ROOT_RENAMES[0] as readonly [string, string])[0]));
}

/**
 * Rename the root's old entries to their new names. Returns what moved (empty
 * when the root was already migrated, or holds none of them). Throws
 * {@link AgentRootConflict} — having moved nothing — when any entry exists
 * under both names.
 */
export function migrateAgentRoot(root: string): RootRename[] {
  const todo: RootRename[] = [];
  for (const [oldName, newName] of AGENT_ROOT_RENAMES) {
    const from = join(root, oldName);
    const to = join(root, newName);
    if (!present(from)) continue;
    if (present(to)) throw new AgentRootConflict(from, to);
    todo.push({ from, to });
  }
  for (const r of todo) renameSync(r.from, r.to);
  return todo;
}

/**
 * {@link migrateAgentRoot} for a verb: each rename is one line through `say`,
 * and a conflict is one line naming both paths, returning false (the verb
 * then exits refused). Any other error is thrown.
 */
export function migrateAgentRootOrSay(root: string, say: (line: string) => void, prefix: string): boolean {
  try {
    for (const r of migrateAgentRoot(root)) say(`${prefix}: renamed ${r.from} -> ${r.to}\n`);
    return true;
  } catch (e) {
    if (e instanceof AgentRootConflict) {
      say(`${prefix}: ${e.message}\n`);
      return false;
    }
    throw e;
  }
}
