/**
 * The one-shot rename of an agent root's `suite` file names to `burrow` ones (0.10.2).
 *
 * Before 0.10.2 an agent root carried `suite.json`, `.suite-stamp.json`,
 * `.suite-state.json`, `.suite-codex/` and `.dsh/suite.patch.yml`. From 0.10.2
 * every verb reads and writes only the `burrow` names, and this module is the
 * ONLY place that spells the old ones. A verb calls {@link migrateAgentRoot}
 * on the path that STARTS its agent, before that path reads anything in the
 * root, and the first start under 0.10.2 or later renames what is there.
 *
 * NEVER WHILE THE AGENT RUNS (0.10.3). A run that attaches to a live session
 * must not rename: the running process may hold an old path (dsh is started
 * with `--patch <root>/.dsh/suite.patch.yml`), and 0.10.2 renamed it from
 * under oddjob's live dsh when a watchdog re-ran `burrow deepseek`. A verb
 * that must read the root before it knows whether it will start or attach
 * reads through {@link readablePath}, which never writes; the rename waits
 * for the start.
 *
 * THE RULES, the same for every entry:
 *
 *  - old exists, new does not: `rename(2)` it. Same directory, so it is atomic
 *    and keeps the mode and the owner (`.burrow-state.json` stays 0600).
 *  - both exist: refuse, naming both paths, and rename NOTHING. Every entry is
 *    checked before any is moved, so a refusal leaves the root as it was.
 *  - only new, or neither: nothing to do.
 *
 * 0.11.0 ADDS THE CONFIG KEY. The same call renames `suiteUrl` to `burrowUrl`
 * in the root's `burrow.json` and in any config file the verb names (its
 * folder record), under the same rules: checked before anything moves, a file
 * holding both keys refuses (legacy_names.ts {@link LegacyNameConflict}).
 *
 * The stamp record survives the rename unchanged: its inputs digest covers the
 * harness, writer version, Burrow URL, runtime id, token ref and the verb's
 * non-secret inputs, and none of those names a file in the root.
 */
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LegacyNameConflict, LEGACY_URL_KEY, URL_KEY, pendingFileRenames, renameFiles } from "./legacy_names.ts";

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

/** The old-named entries `root` still holds (absolute paths); empty once migrated. */
export function legacyNamesIn(root: string): string[] {
  return AGENT_ROOT_RENAMES.map(([oldName]) => join(root, oldName)).filter(present);
}

/**
 * The path to READ for `newName` (relative to `root`) before the root is
 * renamed: the new name when it exists, else the old name when that exists,
 * else the new name. Read-only — for a run that has not yet decided whether
 * it starts the agent (and so may rename) or attaches to it (and so must not).
 */
export function readablePath(root: string, newName: string): string {
  const fresh = join(root, newName);
  if (present(fresh)) return fresh;
  const pair = AGENT_ROOT_RENAMES.find(([, n]) => n === newName);
  if (pair !== undefined && present(join(root, pair[0]))) return join(root, pair[0]);
  return fresh;
}

/**
 * Rename the root's old entries to their new names. Returns what moved (empty
 * when the root was already migrated, or holds none of them). Throws
 * {@link AgentRootConflict} — having moved nothing — when any entry exists
 * under both names.
 */
export function migrateAgentRoot(root: string, configFiles: readonly string[] = []): RootRename[] {
  const todo: RootRename[] = [];
  for (const [oldName, newName] of AGENT_ROOT_RENAMES) {
    const from = join(root, oldName);
    const to = join(root, newName);
    if (!present(from)) continue;
    if (present(to)) throw new AgentRootConflict(from, to);
    todo.push({ from, to });
  }
  // The identity under the name it has NOW, so a conflict refuses before any file moves.
  pendingFileRenames([readablePath(root, "burrow.json"), ...configFiles], null);
  for (const r of todo) renameSync(r.from, r.to);
  const keys = renameFiles([join(root, "burrow.json"), ...configFiles], null);
  return [...todo, ...keys.map((k) => ({ from: `${k.file} ${LEGACY_URL_KEY}`, to: URL_KEY }))];
}

/**
 * {@link migrateAgentRoot} for a verb: each rename is one line through `say`,
 * and a conflict is one line naming both paths, returning false (the verb
 * then exits refused). Any other error is thrown.
 */
export function migrateAgentRootOrSay(
  root: string,
  say: (line: string) => void,
  prefix: string,
  configFiles: readonly string[] = [],
): boolean {
  try {
    for (const r of migrateAgentRoot(root, configFiles)) say(`${prefix}: renamed ${r.from} -> ${r.to}\n`);
    return true;
  } catch (e) {
    if (e instanceof AgentRootConflict || e instanceof LegacyNameConflict) {
      say(`${prefix}: ${e.message}\n`);
      return false;
    }
    throw e;
  }
}
