import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BURROW_CONVENTIONS,
  CONVENTIONS_FILENAME,
  LEGACY_CONVENTIONS_FILENAME,
  SUITE_CONVENTIONS,
  conventionsAdvice,
  conventionsFilename,
  conventionsMd,
  conventionsPlan,
} from "../src/claude_md.ts";
import { usage } from "../src/cli.ts";
import { parseHermesOptions } from "../src/commands/hermes.ts";
import { parseOpenclawOptions } from "../src/commands/openclaw.ts";
import { FALLBACK_SUFFIXES } from "../src/env_names.ts";
import { BESIDE_BREADCRUMB_SUFFIX, BREADCRUMB_FILENAME, LOCK_DIRNAME, STATE_FILENAME } from "../src/migrate.ts";
import { CLI_NAME, VERSION } from "../src/version.ts";

/**
 * 0.8.0 renamed the command from `suite` to `burrow`. These pin the user-facing
 * half of that rename (package, help, hints, docs) and the one compatibility
 * export core's agent-host depends on.
 */

const REPO = resolve(import.meta.dir, "..");

function gitGrep(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["git", "grep", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) };
}

describe("the package says burrow", () => {
  test("name, version and description", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.name).toBe("burrow-cli");
    expect(pkg.version).toBe("0.15.0");
    expect(VERSION).toBe("0.15.0");
    expect(pkg.bin).toEqual({ burrow: "./src/cli.ts" });
    expect(pkg.description).toBe("Connects a machine to a Burrow install, then sets up and runs its agent harness");
    expect(CLI_NAME).toBe("burrow");
  });

  test("no client or person is named in package.json, README.md or src", () => {
    // Positive control first: the same grep over the same paths DOES hit a
    // word that is there, so an empty result below is a real absence and not a
    // grep that cannot match (wrong cwd, wrong pathspec, git missing).
    const control = gitGrep(["-n", "-i", "burrow", "--", "package.json", "README.md", "src"]);
    expect(control.code).toBe(0);
    expect(control.out).not.toBe("");
    const needle = ["ko", "bo"].join(""); // assembled so this file is not its own hit
    const hits = gitGrep(["-n", "-i", needle, "--", "package.json", "README.md", "src"]);
    expect(hits.out).toBe("");
    expect(hits.code).toBe(1); // git grep: 1 = no match, anything else = an error
  });
});

describe("help names burrow", () => {
  test("the header row is burrow and its version; the last line is burrow init", () => {
    const lines = usage().split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]?.trim().split(/\s+/)).toEqual(["burrow", VERSION]);
    expect(lines[lines.length - 1]).toBe("burrow init");
  });

  test("`suite` appears on no line (the alias was removed in 0.10.0)", () => {
    const suiteLines = usage()
      .split("\n")
      .filter((l) => /\bsuite\b/i.test(l));
    expect(suiteLines).toEqual([]);
  });
});

describe("no user-facing string in src names the command `suite`", () => {
  // A quoted literal that STARTS with `suite <verb>` or `suite: ` is a hint or
  // an error prefix. Those all come from CLI_NAME now.
  const VERB = "(init|claude|doctor|status|update|watch|restore|codex|hermes|openclaw|deepseek|--help)";
  const hint = new RegExp(`["'\`](?:[^"'\`\\n]*\\s)?suite (?:${VERB})\\b|["'\`]suite: `);

  test("the pattern fires on the shapes it exists for", () => {
    expect('"run suite init"').toMatch(hint);
    expect("`suite: unknown command`").toMatch(hint);
    expect('"suite claude"').toMatch(hint);
    // ...and not on identifiers that keep the name on purpose.
    expect('"suite-channel"').not.toMatch(hint);
    expect('"suite.json"').not.toMatch(hint);
  });

  test("no file in src carries one", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(REPO, "src"));
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\*|\*|\/\/)/.test(line)) return; // comments
          if (hint.test(line)) hits.push(`${f.slice(REPO.length + 1)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("conventions: core's SUITE_CONVENTIONS keeps loading", () => {
  test("SUITE_CONVENTIONS is BURROW_CONVENTIONS and carries suite_reply (core's --check)", () => {
    expect(SUITE_CONVENTIONS).toBe(BURROW_CONVENTIONS);
    expect(typeof SUITE_CONVENTIONS).toBe("string");
    expect(SUITE_CONVENTIONS.length).toBeGreaterThan(0);
    expect(SUITE_CONVENTIONS).toContain("suite_reply");
    expect(BURROW_CONVENTIONS).toContain("Burrow");
  });

  test("a dynamic import by absolute path, the way agent-host loads it, sees the export", async () => {
    const mod = (await import(join(REPO, "src/claude_md.ts"))) as { SUITE_CONVENTIONS?: unknown };
    expect(typeof mod.SUITE_CONVENTIONS).toBe("string");
    expect(String(mod.SUITE_CONVENTIONS)).toContain("suite_reply");
  });

  test("claude_md.ts imports nothing, so it loads standalone from the lib dir", () => {
    const src = readFileSync(join(REPO, "src/claude_md.ts"), "utf8");
    expect(src).toContain("export const SUITE_CONVENTIONS"); // anti-vacuity: right file
    expect(src.split("\n").filter((l) => /^\s*import\b/.test(l))).toEqual([]);
  });
});

describe("conventions filename: never rename an existing file", () => {
  const none = (): boolean => false;
  const only = (name: string) => (n: string): boolean => n === name;

  test("a folder with neither file and no link gets BURROW_CONVENTIONS.md", () => {
    expect(conventionsFilename(null, none)).toBe("BURROW_CONVENTIONS.md");
    expect(conventionsFilename("# project guide\n", none)).toBe(CONVENTIONS_FILENAME);
  });

  test("an existing SUITE_CONVENTIONS.md keeps its name", () => {
    expect(conventionsFilename("# guide\n", only(LEGACY_CONVENTIONS_FILENAME))).toBe("SUITE_CONVENTIONS.md");
  });

  test("a CLAUDE.md that loads the old name keeps it, even when the file is gone", () => {
    expect(conventionsFilename("@SUITE_CONVENTIONS.md\n", none)).toBe("SUITE_CONVENTIONS.md");
  });

  test("what CLAUDE.md loads beats what exists; the new name wins a tie", () => {
    expect(conventionsFilename("@BURROW_CONVENTIONS.md\n", only(LEGACY_CONVENTIONS_FILENAME))).toBe(CONVENTIONS_FILENAME);
    expect(conventionsFilename(null, () => true)).toBe(CONVENTIONS_FILENAME);
  });

  test("a CLAUDE.md that loads either name reads as linked", () => {
    expect(conventionsPlan("/r/SUITE_CONVENTIONS.md", "@SUITE_CONVENTIONS.md").claudeMd).toBe("linked");
    expect(conventionsPlan("/r/BURROW_CONVENTIONS.md", "@BURROW_CONVENTIONS.md").claudeMd).toBe("linked");
  });

  test("advice and the file body name the file actually written", () => {
    const plan = conventionsPlan("/r/SUITE_CONVENTIONS.md", "# guide\n");
    expect(conventionsAdvice(plan).join("\n")).toContain("@SUITE_CONVENTIONS.md");
    expect(conventionsMd("SUITE_CONVENTIONS.md")).toContain("    @SUITE_CONVENTIONS.md");
    expect(conventionsMd()).toContain("    @BURROW_CONVENTIONS.md");
  });
});

describe("--burrow-url beside --suite-url", () => {
  const root = "/tmp/burrow-naming-root";
  for (const [name, parse] of [
    ["hermes", (a: string[]) => parseHermesOptions(a, "/")],
    ["openclaw", (a: string[]) => parseOpenclawOptions(a, "/")],
  ] as const) {
    test(`${name}: --suite-url alone still works`, () => {
      expect(parse(["--root", root, "--suite-url", "https://old.example.test"]).suiteUrl).toBe("https://old.example.test");
    });
    test(`${name}: --burrow-url alone works`, () => {
      expect(parse(["--root", root, "--burrow-url", "https://new.example.test"]).suiteUrl).toBe("https://new.example.test");
    });
    test(`${name}: both given, --burrow-url wins whatever the order`, () => {
      const a = ["--suite-url", "https://old.example.test", "--burrow-url", "https://new.example.test"];
      const b = ["--burrow-url", "https://new.example.test", "--suite-url", "https://old.example.test"];
      expect(parse(["--root", root, ...a]).suiteUrl).toBe("https://new.example.test");
      expect(parse(["--root", root, ...b]).suiteUrl).toBe("https://new.example.test");
    });
  }
});

describe("README", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");

  test("installs with the published one-liner and shows burrow verbs", () => {
    expect(readme).toContain(
      "curl -fsSL https://raw.githubusercontent.com/GetBurrowing/burrow-cli/main/install.sh | sh",
    );
    expect(readme).toContain("burrow init && burrow claude");
  });

  test("Compatibility lists every SUITE_* fallback pair, the alias removal, the one-shot move and its breadcrumbs, and the repo rename", () => {
    const start = readme.indexOf("## Compatibility");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    expect(FALLBACK_SUFFIXES.length).toBe(17); // the raw list is pinned in env_names.test.ts
    for (const s of FALLBACK_SUFFIXES) {
      expect(section).toContain(`| \`BURROW_${s}\` | \`SUITE_${s}\` |`);
    }
    expect(section).toContain("**The `suite` command is gone (0.10.0).**");
    expect(section).not.toContain("suite keeps working");
    expect(section).toContain("### The 0.11.0 rename: MCP server ids, config key, launch flag");
    expect(section).toContain("| MCP server id `suite-channel` | `burrow-channel` |");
    expect(section).toContain("| MCP server id `startup-suite` | `burrow` |");
    // The one-shot migration, named by the files it leaves (from the code, not retyped).
    expect(section).toContain("State moves once, on the first 0.9 run.");
    expect(section).toContain(`\`${BREADCRUMB_FILENAME}\``);
    expect(section).toContain(`\`<old>${BESIDE_BREADCRUMB_SUFFIX}\``);
    expect(section).toContain(`\`<state>/burrow/${STATE_FILENAME}\``);
    expect(section).toContain(`\`${LOCK_DIRNAME}\``);
    // 0.8's rules are gone: the config dir no longer depends on what exists, and nothing claims the old dirs stay.
    expect(section).not.toContain("chosen once, by what exists");
    expect(section).not.toContain("are unchanged: `~/.local/share/suite/`");
    expect(section).toContain("The repo is `burrow-cli`; it was");
  });
});

describe("the old repo name survives only where the fallback needs it", () => {
  // 0.9.0 renamed the repo to burrow-cli. The old name is still spelled where
  // a fetch falls back to it and where the README explains that fallback.
  // Tests and the changelog are out of scope: tests have to exercise the
  // fallback by name, and past changelog entries are records.
  const OLD_REPO = ["suite", "cli"].join("-");
  const SCOPE = ["src", "assets", "install.sh", "README.md", "package.json", "bun.lock"];
  const KEPT: { file: string; text: string; why: string }[] = [
    { file: "src/repo_source.ts", text: `export const LEGACY_CLI_REPO_NAME = "${OLD_REPO}";`, why: "the constant; update.ts re-exports it as LEGACY_REPO_NAME" },
    { file: "install.sh", text: `REPO_NAMES="burrow-cli ${OLD_REPO}"`, why: "the POSIX installer's copy of the constant; it cannot import TypeScript" },
    { file: "README.md", text: `it was \`${OLD_REPO}\` before 0.9.0.`, why: "the compatibility note" },
    { file: "README.md", text: `and \`${OLD_REPO}\` only when that answers 404`, why: "the compatibility note" },
    { file: "src/commands/openclaw.ts", text: `const CHECKOUT_MARKER = ".${OLD_REPO}-deps-ref";`, why: "an on-disk marker existing plugin checkouts carry; renaming it re-runs npm ci" },
  ];

  test("every occurrence is a kept line, and every kept line is still there exactly once", () => {
    const g = gitGrep(["-n", "-I", "-F", OLD_REPO, "--", ...SCOPE]);
    expect(g.code).toBe(0); // positive control: the kept lines are found at all
    const hits = g.out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [file, , ...rest] = l.split(":");
        return { file: file as string, text: rest.join(":") };
      });
    const unlisted = hits.filter((h) => !KEPT.some((k) => k.file === h.file && h.text.includes(k.text)));
    expect(unlisted).toEqual([]);
    for (const k of KEPT) {
      expect({ kept: k.text, lines: hits.filter((h) => h.file === k.file && h.text.includes(k.text)).length }).toEqual({ kept: k.text, lines: 1 });
    }
  });
});
