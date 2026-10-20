import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The product is Burrow. No code, README or doc here says otherwise, except
 * the lines listed below, each with the reason it has to keep the old name.
 *
 * THE DETECTOR is the census the rename was measured with: a line hits when
 * it has the old product name as a capitalised word, or the two-word old
 * name, and is not a `<org>/` URL or the English phrase "test suite". It runs
 * over every file `git ls-files` reports (tracked, plus untracked files that
 * are not ignored, since a new file is the likeliest place for a paste).
 *
 * THE ALLOWLIST is RAW, one entry per kept line: the file, a substring of
 * that line, and why. Every hit must be claimed by exactly one entry, and
 * every entry must claim exactly one hit. So the test fails three ways: a new
 * hit nobody listed, an entry whose line is gone (stale), and a second copy
 * of a listed line (an entry claiming two).
 *
 * This file is the one path the scan skips: it spells the patterns it looks
 * for. The skip is asserted to be exactly this file.
 *
 * Names that stay `suite` in lowercase (the alias, SUITE_* fallbacks, MCP
 * server and tool ids, legacy paths, unit names, the bundled dsh plugin's
 * `suite-federation` dir) are not hits: the detector is case-sensitive and
 * word-bounded, so they never reach this list.
 */

const REPO = resolve(import.meta.dir, "..");
const SELF = relative(REPO, import.meta.path);

/** Assembled, so that this file's own source is not a hit for a reader grepping it. */
const OLD = ["Su", "ite"].join("");
const HIT = new RegExp(`\\b${OLD}\\b|Startup ${OLD}`);
const NOT_A_HIT = new RegExp(`Startup-${OLD}/|test ${OLD.toLowerCase()}`);
/** Core A2's naming rule: the product is never the two names together. */
const COMBINED = new RegExp(`Burrow[ -]${OLD}`);

const HISTORY = "A changelog entry before 0.9.0: a record of what shipped under the old name. Only the 0.9.0 entry is rewritten.";
const LEGACY_UNIT = "A pre-0.9.0 systemd unit, verbatim, as the migration finds it on a host; and the assertion that the swapped unit no longer says it.";

interface Allowed {
  file: string;
  text: string;
  reason: string;
}

export const ALLOWLIST: readonly Allowed[] = [
  { file: "CHANGELOG.md", text: "- **dsh agents can post into a Suite space: the federation plugin registers a", reason: HISTORY },
  { file: "CHANGELOG.md", text: "`suite_reply` tool.** The hosted Suite MCP surface has no tool that posts a", reason: HISTORY },
  { file: "CHANGELOG.md", text: "- **The default stays `Startup-Suite`.** URLs under it keep working after the", reason: HISTORY },
  { file: "CHANGELOG.md", text: "`.mcp.json` name different runtimes or hosts, and on any user-scope Suite", reason: HISTORY },
  { file: "CHANGELOG.md", text: "- **`suite codex`: a Codex agent in Suite, through `codex app-server`.** It", reason: HISTORY },
  { file: "CHANGELOG.md", text: "config file is edited and no token is in an argv. Each Suite space maps to", reason: HISTORY },
  { file: "CHANGELOG.md", text: "- **`suite init` is harness-neutral.** It connects the machine to a Suite", reason: HISTORY },
  { file: "CHANGELOG.md", text: "Suite wiring, which is what it did before. `suite deepseek` refuses as before.", reason: HISTORY },
  { file: "CHANGELOG.md", text: "agent replaced the first agent's entries with the second one's Suite and", reason: HISTORY },
  { file: "CHANGELOG.md", text: "Suite-ready, then run its gateway in a persistent tmux session.** Each agent's", reason: HISTORY },
  { file: "CHANGELOG.md", text: "- **`suite hermes` stamps a lean toolset for the Suite platform by default.**", reason: HISTORY },
  { file: "CHANGELOG.md", text: "clarify, plus every enabled MCP server, so the Suite bridge stays) and no", reason: HISTORY },
  { file: "CHANGELOG.md", text: "the Suite MCP bundle, shell and file tools widen what untrusted chat can", reason: HISTORY },
  { file: "CHANGELOG.md", text: "- **`suite init` seeds a starting `CLAUDE.md`** for new Suite agents \u2014 how a", reason: HISTORY },
  { file: "test/migrate_rewrites.test.ts", text: "Description=Suite agent session watchdog", reason: LEGACY_UNIT },
  { file: "test/migrate_rewrites.test.ts", text: "Description=Restore Suite agent sessions after boot", reason: LEGACY_UNIT },
  { file: "test/migrate_rewrites.test.ts", text: "expect(unit).not.toContain(\"Description=Suite\");", reason: LEGACY_UNIT },
];

export interface Hit {
  file: string;
  line: number;
  text: string;
}

function listedFiles(): string[] {
  const p = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    stdout: "pipe",
  });
  expect(p.exitCode).toBe(0);
  return new TextDecoder().decode(p.stdout).split("\0").filter((f) => f !== "");
}

/** Every census hit in `files`, read from disk. Binary files (a NUL byte) are skipped, as `git grep -I` does. */
export function census(files: string[], read: (f: string) => string | null): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const body = read(file);
    if (body === null || body.includes("\0")) continue;
    body.split("\n").forEach((text, i) => {
      if (HIT.test(text) && !NOT_A_HIT.test(text)) hits.push({ file, line: i + 1, text });
    });
  }
  return hits;
}

/** Hits no entry claims, entries that claim no hit, and entries that claim more than one. */
export function audit(hits: Hit[], allow: readonly Allowed[]): { unlisted: string[]; stale: string[]; ambiguous: string[] } {
  const claims = allow.map((a) => hits.filter((h) => h.file === a.file && h.text.includes(a.text)));
  const unlisted = hits
    .filter((h) => !allow.some((a) => h.file === a.file && h.text.includes(a.text)))
    .map((h) => `${h.file}:${h.line}: ${h.text.trim()}`);
  const stale = allow.filter((_, i) => claims[i]?.length === 0).map((a) => `${a.file}: ${a.text}`);
  const ambiguous = allow.flatMap((a, i) => {
    const n = claims[i]?.length ?? 0;
    return n > 1 ? [`${a.file}: ${a.text} (${n} lines)`] : [];
  });
  return { unlisted, stale, ambiguous };
}

function readTracked(file: string): string | null {
  try {
    return readFileSync(join(REPO, file), "utf8");
  } catch {
    return null; // listed but deleted in the working tree
  }
}

const FILES = listedFiles();
const SCANNED = FILES.filter((f) => f !== SELF);
const HITS = census(SCANNED, readTracked);

describe("the detector", () => {
  test("fires on the shapes it exists for and on nothing it is told to leave", () => {
    const at = (text: string): number => census(["x"], () => text).length;
    expect(at(`connect to a ${OLD} install`)).toBe(1);
    expect(at(`Startup ${OLD} Channel`)).toBe(1);
    expect(at(`${OLD}-ready`)).toBe(1);
    expect(at(`OWNER="Startup-${OLD}"`)).toBe(1); // the org literal is a hit, so it must be listed
    expect(at(`https://github.com/Startup-${OLD}/burrow-cli`)).toBe(0);
    expect(at(`the whole test ${OLD.toLowerCase()} passes`)).toBe(0);
    expect(at("SUITE_URL suite-channel suite_reply mcp__startup-suite__x")).toBe(0);
    expect(at(`${OLD}s and ${OLD}case`)).toBe(0);
  });

  test("the scan is not vacuous: it reads the repo and skips exactly this file", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain(SELF);
    expect(FILES.filter((f) => !SCANNED.includes(f))).toEqual([SELF]);
    expect(SCANNED).toContain("README.md");
    expect(SCANNED).toContain("src/cli.ts");
  });

  test("audit reports an unlisted hit, a stale entry and a doubled line", () => {
    const allow = [{ file: "a", text: "kept", reason: "r" }, { file: "a", text: "gone", reason: "r" }];
    const hits = [
      { file: "a", line: 1, text: "kept" },
      { file: "a", line: 2, text: "kept" },
      { file: "b", line: 1, text: "new" },
    ];
    expect(audit(hits, allow)).toEqual({ unlisted: ["b:1: new"], stale: ["a: gone"], ambiguous: ["a: kept (2 lines)"] });
  });
});

describe("product name", () => {
  test("every hit is allowlisted, and every allowlist entry matches exactly one line", () => {
    expect(audit(HITS, ALLOWLIST)).toEqual({ unlisted: [], stale: [], ambiguous: [] });
  });

  test("every allowlist entry carries a reason", () => {
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(20);
  });

  test("the changelog keeps the old name only in entries before 0.9.0", () => {
    const lines = readFileSync(join(REPO, "CHANGELOG.md"), "utf8").split("\n");
    const current = lines.indexOf("## 0.9.0");
    const firstPast = lines.findIndex((l, i) => i > current && l.startsWith("## "));
    expect(current).toBeGreaterThan(0);
    expect(firstPast).toBeGreaterThan(current);
    const changelogHits = HITS.filter((h) => h.file === "CHANGELOG.md");
    expect(changelogHits.length).toBeGreaterThan(0); // anti-vacuity: the history does still say it
    for (const h of changelogHits) expect(h.line - 1).toBeGreaterThan(firstPast);
  });

  test(`the product is never "Burrow ${OLD}"`, () => {
    expect(COMBINED.test(`Burrow ${OLD}`)).toBe(true); // the pattern can fire
    const found: string[] = [];
    for (const file of SCANNED) {
      const body = readTracked(file);
      if (body === null || body.includes("\0")) continue;
      body.split("\n").forEach((text, i) => {
        if (COMBINED.test(text)) found.push(`${file}:${i + 1}: ${text.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
