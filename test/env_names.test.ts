import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  bothNames,
  burrowName,
  deprecationLine,
  envSource,
  entryAgrees,
  entryValue,
  envValue,
  FALLBACK_SUFFIXES,
  setDeprecationSink,
  suiteName,
} from "../src/env_names.ts";

const REPO = resolve(import.meta.dir, "..");

let lines: string[] = [];
let restore: (line: string) => void;

beforeEach(() => {
  lines = [];
  restore = setDeprecationSink((l) => void lines.push(l));
});

afterEach(() => {
  setDeprecationSink(restore);
});

describe("envValue: BURROW_ first, SUITE_ fallback", () => {
  test("BURROW only: its value, no deprecation line", () => {
    expect(envValue({ BURROW_URL: "https://b" }, "URL")).toBe("https://b");
    expect(lines).toEqual([]);
  });

  test("SUITE only: its value, and exactly one deprecation line however often it is read", () => {
    const env = { SUITE_URL: "https://s" };
    expect(envValue(env, "URL")).toBe("https://s");
    expect(envValue(env, "URL")).toBe("https://s");
    expect(envValue(env, "URL")).toBe("https://s");
    expect(lines).toEqual(["burrow: SUITE_URL is deprecated, set BURROW_URL"]);
  });

  test("one line PER SUFFIX: a second legacy name gets its own line", () => {
    envValue({ SUITE_URL: "a" }, "URL");
    envValue({ SUITE_TOKEN: "b" }, "TOKEN");
    envValue({ SUITE_URL: "c" }, "URL");
    expect(lines).toEqual([deprecationLine("URL"), deprecationLine("TOKEN")]);
  });

  test("both set with different values: BURROW wins, no deprecation line", () => {
    expect(envValue({ BURROW_CLI_REF: "new", SUITE_CLI_REF: "old" }, "CLI_REF")).toBe("new");
    expect(lines).toEqual([]);
  });

  test("empty BURROW falls back to SUITE", () => {
    expect(envValue({ BURROW_LIB_DIR: "", SUITE_LIB_DIR: "/opt/lib" }, "LIB_DIR")).toBe("/opt/lib");
    expect(lines).toEqual([deprecationLine("LIB_DIR")]);
  });

  test("neither set: undefined; an empty SUITE is returned as empty and does not warn", () => {
    expect(envValue({}, "URL")).toBeUndefined();
    expect(envValue({ SUITE_URL: "" }, "URL")).toBe("");
    expect(lines).toEqual([]);
  });

  test("envSource names the variable that supplied the value", () => {
    expect(envSource({ BURROW_TOKEN: "x", SUITE_TOKEN: "y" }, "TOKEN")).toEqual({ name: "BURROW_TOKEN", value: "x" });
    expect(envSource({ SUITE_TOKEN: "y" }, "TOKEN")).toEqual({ name: "SUITE_TOKEN", value: "y" });
    expect(envSource({}, "TOKEN")).toBeNull();
  });

  test("the deprecation line is the exact documented text", () => {
    expect(deprecationLine("GITHUB_OWNER")).toBe("burrow: SUITE_GITHUB_OWNER is deprecated, set BURROW_GITHUB_OWNER");
  });

  test("the default sink is stderr: a real child process prints the line once, to stderr only", () => {
    const script = `
      import { envValue } from ${JSON.stringify(resolve(REPO, "src/env_names.ts"))};
      envValue({ SUITE_URL: "u" }, "URL");
      envValue({ SUITE_URL: "u" }, "URL");
      process.stdout.write("done");
    `;
    const p = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(new TextDecoder().decode(p.stdout)).toBe("done");
    expect(new TextDecoder().decode(p.stderr)).toBe("burrow: SUITE_URL is deprecated, set BURROW_URL\n");
  });
});

describe("bothNames", () => {
  test("returns the value under both generations' names", () => {
    expect(bothNames("RUNTIME_ID", "rt-1")).toEqual({ BURROW_RUNTIME_ID: "rt-1", SUITE_RUNTIME_ID: "rt-1" });
  });

  test("the names are a pure prefix swap", () => {
    for (const s of FALLBACK_SUFFIXES) {
      expect(burrowName(s)).toBe(`BURROW_${s}`);
      expect(suiteName(s)).toBe(`SUITE_${s}`);
    }
  });
});

describe("entryValue / entryAgrees: an MCP entry's env, both generations", () => {
  test("BURROW wins when both are set and disagree; SUITE alone is the fallback; empty or non-string is absent", () => {
    expect(entryValue({ BURROW_URL: "new", SUITE_URL: "old" }, "URL")).toBe("new");
    expect(entryValue({ SUITE_URL: "old" }, "URL")).toBe("old");
    expect(entryValue({ BURROW_URL: " ", SUITE_URL: "old" }, "URL")).toBe("old");
    expect(entryValue({ BURROW_URL: 7, SUITE_URL: "old" }, "URL")).toBe("old");
    expect(entryValue({}, "URL")).toBeUndefined();
    expect(entryValue(undefined, "URL")).toBeUndefined();
  });

  test("reading an entry never prints a deprecation line: the file is not the operator's environment", () => {
    const lines: string[] = [];
    const prev = setDeprecationSink((l) => void lines.push(l));
    entryValue({ SUITE_URL: "old" }, "URL");
    entryAgrees({ SUITE_URL: "old" }, "URL", "old");
    setDeprecationSink(prev);
    expect(lines).toEqual([]);
  });

  test("entryAgrees: every present name must equal the wanted value, and at least one must be present", () => {
    expect(entryAgrees({ SUITE_URL: "u" }, "URL", "u")).toBe(true);
    expect(entryAgrees({ BURROW_URL: "u" }, "URL", "u")).toBe(true);
    expect(entryAgrees({ BURROW_URL: "u", SUITE_URL: "u" }, "URL", "u")).toBe(true);
    expect(entryAgrees({ BURROW_URL: "u", SUITE_URL: "old" }, "URL", "u")).toBe(false);
    expect(entryAgrees({ BURROW_URL: "old", SUITE_URL: "u" }, "URL", "u")).toBe(false);
    expect(entryAgrees({}, "URL", "u")).toBe(false);
  });
});

describe("FALLBACK_SUFFIXES", () => {
  test("is exactly this raw list, in this order: a missed or an extra name fails here", () => {
    // Hand-written on purpose. Do not derive it from the module under test.
    expect([...FALLBACK_SUFFIXES]).toEqual([
      "GITHUB_OWNER",
      "CLI_REF",
      "CLI_TARBALL_URL",
      "LIB_DIR",
      "VERSION",
      "MCP_URL",
      "WS_URL",
      "RUNTIME_ID",
      "RUNTIME_TOKEN",
      "TOKEN",
      "URL",
      "TELEMETRY_AUTH",
      "WATCH_SUPERVISED",
      "CODEX_BRIDGE_SOCKET",
      "ALLOW_PERMISSION_RELAY",
      "CLI_ALLOW_NO_TMUX",
      "CLI_ALLOW_NO_CODEX",
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* Only env_names.ts reads a SUITE_* name from an environment                 */
/* ------------------------------------------------------------------------- */

function srcFiles(): string[] {
  const p = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "src"], {
    cwd: REPO,
    stdout: "pipe",
  });
  return new TextDecoder()
    .decode(p.stdout)
    .split("\0")
    .filter((f) => f.endsWith(".ts"));
}

/** `env.SUITE_`, `env?.SUITE_`, `env["SUITE_`, `env?.["SUITE_` — `process.env.` included. */
const DIRECT_READ = /\benv\??\.?(?:SUITE_|\[\s*["'`]SUITE_)/;

/** A whole quoted `"SUITE_X"` name: the way a read hides behind a constant (`env[NAME]`). */
const QUOTED_NAME = /["']SUITE_[A-Z0-9_]+["']/;

const isComment = (line: string): boolean => /^(\*|\/\/|\/\*)/.test(line);

async function hits(pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const file of srcFiles()) {
    if (file === "src/env_names.ts") continue;
    const text = await Bun.file(resolve(REPO, file)).text();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (isComment(line)) continue;
      if (pattern.test(line)) out.push(`${file}| ${line}`);
    }
  }
  return out.sort();
}

/**
 * The SUITE_* reads that are NOT reads of this process's configuration, so they
 * correctly stay on the legacy name. Matched by file and full line text (not
 * line number), so an added read anywhere fails the test.
 *
 *  - deepseek's `!!js process.env.BURROW_* || process.env.SUITE_*` lines are
 *    generated code run inside the dsh child, reading names this CLI itself
 *    sets (BOTH generations) in that child's env (publicEnv / secretEnv).
 *
 * Reads of an MCP ENTRY's env (agent_inventory, claude_wiring, init, doctor)
 * used to be listed here; since 01a14b9f stage 3 they go through
 * `entryValue` / `entryAgrees` / `burrowName`+`suiteName`, BURROW first, so
 * none of them names a SUITE_* variable directly any more.
 */
const DIRECT_READ_ALLOWED = [
  "src/commands/deepseek.ts| Authorization: !!js '\\`Bearer \\${process.env.BURROW_RUNTIME_TOKEN || process.env.SUITE_RUNTIME_TOKEN}\\`'",
  "src/commands/deepseek.ts| runtimeId: !!js process.env.BURROW_RUNTIME_ID || process.env.SUITE_RUNTIME_ID",
  "src/commands/deepseek.ts| token: !!js process.env.BURROW_RUNTIME_TOKEN || process.env.SUITE_RUNTIME_TOKEN",
  "src/commands/deepseek.ts| url: !!js process.env.BURROW_MCP_URL || process.env.SUITE_MCP_URL",
  "src/commands/deepseek.ts| url: !!js process.env.BURROW_WS_URL || process.env.SUITE_WS_URL",
].sort();

const QUOTED_NAME_ALLOWED: string[] = [];

describe("only env_names.ts reads SUITE_* from the process environment", () => {
  test("anti-vacuity: the scan sees the source tree, and the patterns match a known read", () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("src/env_names.ts");
    expect(DIRECT_READ.test("?? env.SUITE_X")).toBe(true);
    expect(DIRECT_READ.test('env["SUITE_X"]')).toBe(true);
    expect(DIRECT_READ.test("process.env?.SUITE_X")).toBe(true);
    expect(QUOTED_NAME.test('const N = "SUITE_X";')).toBe(true);
  });

  test("direct env.SUITE_* reads outside env_names.ts are exactly the allowlisted non-process ones", async () => {
    expect(await hits(DIRECT_READ)).toEqual(DIRECT_READ_ALLOWED);
  });

  test("no quoted SUITE_* name outside env_names.ts at all", async () => {
    expect(await hits(QUOTED_NAME)).toEqual(QUOTED_NAME_ALLOWED);
  });
});
