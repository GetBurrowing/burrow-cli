import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ROOT_RENAMES,
  AgentRootConflict,
  holdsLegacyIdentity,
  migrateAgentRoot,
  migrateAgentRootOrSay,
} from "../src/agent_root_names.ts";
import { IDENTITY_FILE, STAMP_FILE } from "../src/stamp.ts";
import { AGENT_CONFIG_FILE, AGENT_PATCH_FILE, AGENT_STATE_FILE } from "../src/commands/deepseek.ts";
import { CODEX_STATE_DIR } from "../src/commands/codex.ts";
import { ROOT_CONFIG_FILE } from "../src/agent_inventory.ts";

/**
 * The 0.10.2 one-shot rename of an agent root's `suite` names. Every content
 * below is fake; no credential is read or printed.
 */
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), `burrow-root-names-${process.pid}-`));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A root exactly as 0.10.1 left it, with distinct bytes in each entry. */
function legacyRoot(): Record<string, string> {
  const bytes: Record<string, string> = {
    "suite.json": '{"suiteUrl":"https://burrow.example.invalid","runtimeId":"r1","headerNames":[]}\n',
    ".suite-stamp.json": '{"harness":"hermes","inputsDigest":"sha256:00","verdict":"pass"}\n',
    ".suite-state.json": '{"token":"fake-not-a-token"}\n',
  };
  for (const [n, t] of Object.entries(bytes)) writeFileSync(join(root, n), t);
  chmodSync(join(root, ".suite-state.json"), 0o600);
  mkdirSync(join(root, ".suite-codex"), { mode: 0o700 });
  writeFileSync(join(root, ".suite-codex", "threads.json"), '{"version":1,"threads":{"s":"t"}}\n');
  mkdirSync(join(root, ".dsh"));
  writeFileSync(join(root, ".dsh", "suite.patch.yml"), "patch: 1\n");
  return bytes;
}

describe("the names", () => {
  test("every verb's constant is the new name in the rename table", () => {
    const next = AGENT_ROOT_RENAMES.map(([, n]) => n);
    expect(next).toEqual([IDENTITY_FILE, STAMP_FILE, AGENT_STATE_FILE, CODEX_STATE_DIR, join(".dsh", AGENT_PATCH_FILE)]);
    expect(AGENT_CONFIG_FILE).toBe(IDENTITY_FILE);
    expect(ROOT_CONFIG_FILE).toBe(IDENTITY_FILE);
    for (const [, n] of AGENT_ROOT_RENAMES) expect(n).not.toMatch(/suite/);
    for (const [o] of AGENT_ROOT_RENAMES) expect(o).toMatch(/suite/);
  });
});

describe("migrateAgentRoot", () => {
  test("fresh: all five renamed in place, same bytes, same mode and owner; .burrow-state.json stays 0600", () => {
    const bytes = legacyRoot();
    const before = Object.fromEntries(AGENT_ROOT_RENAMES.map(([o]) => [o, statSync(join(root, o))]));
    expect(holdsLegacyIdentity(root)).toBe(true);
    const moved = migrateAgentRoot(root);
    expect(moved.map((m) => m.to)).toEqual(AGENT_ROOT_RENAMES.map(([, n]) => join(root, n)));
    for (const [o, n] of AGENT_ROOT_RENAMES) {
      expect(existsSync(join(root, o))).toBe(false);
      const st = statSync(join(root, n));
      expect(st.mode).toBe(before[o]?.mode as number);
      expect(st.uid).toBe(before[o]?.uid as number);
      expect(st.ino).toBe(before[o]?.ino as number);
    }
    expect(statSync(join(root, ".burrow-state.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "burrow.json"), "utf8")).toBe(bytes["suite.json"] as string);
    expect(readFileSync(join(root, ".burrow-stamp.json"), "utf8")).toBe(bytes[".suite-stamp.json"] as string);
    expect(readFileSync(join(root, ".burrow-codex", "threads.json"), "utf8")).toContain('"s":"t"');
    expect(readFileSync(join(root, ".dsh", "burrow.patch.yml"), "utf8")).toBe("patch: 1\n");
    expect(holdsLegacyIdentity(root)).toBe(false);
  });

  test("already migrated: a second run is a no-op", () => {
    legacyRoot();
    migrateAgentRoot(root);
    const snapshot = AGENT_ROOT_RENAMES.map(([, n]) => statSync(join(root, n)).mtimeMs);
    expect(migrateAgentRoot(root)).toEqual([]);
    expect(AGENT_ROOT_RENAMES.map(([, n]) => statSync(join(root, n)).mtimeMs)).toEqual(snapshot);
  });

  test("a root with none of them: no-op", () => {
    expect(migrateAgentRoot(root)).toEqual([]);
    expect(migrateAgentRoot(join(root, "does-not-exist"))).toEqual([]);
  });

  test("partial: only the old names present are renamed", () => {
    writeFileSync(join(root, "suite.json"), "{}\n");
    expect(migrateAgentRoot(root).map((m) => m.to)).toEqual([join(root, "burrow.json")]);
  });

  test("both names present: refuses naming both paths, and renames NOTHING, not even the entries that were clear", () => {
    legacyRoot();
    writeFileSync(join(root, ".burrow-state.json"), "{}\n");
    let caught: unknown;
    try {
      migrateAgentRoot(root);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentRootConflict);
    const msg = (caught as Error).message;
    expect(msg).toContain(join(root, ".suite-state.json"));
    expect(msg).toContain(join(root, ".burrow-state.json"));
    for (const [o] of AGENT_ROOT_RENAMES) expect(existsSync(join(root, o))).toBe(true);
    expect(existsSync(join(root, "burrow.json"))).toBe(false);
  });

  test("migrateAgentRootOrSay: one line per rename, false and one line on a conflict", () => {
    writeFileSync(join(root, "suite.json"), "{}\n");
    const lines: string[] = [];
    expect(migrateAgentRootOrSay(root, (l) => lines.push(l), "burrow")).toBe(true);
    expect(lines).toEqual([`burrow: renamed ${join(root, "suite.json")} -> ${join(root, "burrow.json")}\n`]);
    writeFileSync(join(root, "suite.json"), "{}\n");
    lines.length = 0;
    expect(migrateAgentRootOrSay(root, (l) => lines.push(l), "burrow")).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("both exist");
  });
});
