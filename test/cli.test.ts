import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseClaudeOptions, run, usage } from "../src/cli.ts";
import { emptyConfig } from "../src/config.ts";
import { sessionNameFromConfig } from "../src/tmux.ts";
import { row, nextCommand, colorEnabled, LABEL_WIDTH } from "../src/ui.ts";

describe("verb dispatch", () => {
  test("recognises each verb", () => {
    expect(parse(["init"]).verb).toBe("init");
    expect(parse(["doctor"]).verb).toBe("doctor");
    expect(parse(["status"]).verb).toBe("status");
    expect(parse(["claude"]).verb).toBe("claude");
  });

  test("claude new is the single explicit force-new form", () => {
    const d = parse(["claude", "new", "--resume"]);
    expect(d.verb).toBe("claude new");
    expect(d.args).toEqual(["--resume"]);
  });

  test("passes user arguments through verbatim and in order", () => {
    const args = ["--resume", "two words", "it's \"quoted\"", "$HOME", "--", "-p"];
    expect(parse(["claude", ...args]).args).toEqual(args);
  });

  test("an unknown command exits non-zero", async () => {
    expect(parse(["nope"]).verb).toBe(null);
    expect(await run(["nope"])).toBe(2);
  });

  test("--version and --help exit 0", async () => {
    expect(await run(["--version"])).toBe(0);
    expect(await run(["--help"])).toBe(0);
  });
});

describe("output primitives", () => {
  test("row pads the label column to a fixed width", () => {
    expect(row("bun", "1.2.4")).toBe(`  ${"bun".padEnd(LABEL_WIDTH)}1.2.4`);
  });

  test("the next command carries zero indent", () => {
    expect(nextCommand("burrow init")).toBe("burrow init");
  });

  test("usage ends with the next command at zero indent", () => {
    const lines = usage().split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toBe("burrow init");
    expect(last).toBe(last.trimStart());
  });

  test("NO_COLOR disables colour even on a TTY", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* `--session NAME` — the one option `suite claude` owns                      */
/* ------------------------------------------------------------------------- */

describe("suite claude --session", () => {
  test("the name is captured AND removed from what reaches Claude", () => {
    // Both halves matter: a flag we consumed must not also be forwarded, or
    // Claude sees an option it does not have.
    expect(parseClaudeOptions(["--session", "brosnan"])).toEqual({ session: "brosnan", rest: [] });
    expect(parseClaudeOptions(["--session", "moore", "--resume"])).toEqual({
      session: "moore",
      rest: ["--resume"],
    });
  });

  test("CONTROL: without the flag, every argument still passes through untouched", () => {
    // Kills a parser that ate arguments unconditionally.
    expect(parseClaudeOptions(["--resume", "-p", "hello world"])).toEqual({
      rest: ["--resume", "-p", "hello world"],
    });
    expect(parseClaudeOptions([])).toEqual({ rest: [] });
  });

  test("after `--` it is CLAUDE's flag, untouched — the terminator's whole purpose", () => {
    // The module said in advance that `suite claude -- --resume` must keep
    // working once the wrapper grew an option. This is that promise, tested.
    expect(parseClaudeOptions(["--", "--session", "theirs"])).toEqual({
      rest: ["--", "--session", "theirs"],
    });
    // Ours before the terminator, theirs after, in the same command line.
    expect(parseClaudeOptions(["--session", "ours", "--", "--session", "theirs"])).toEqual({
      session: "ours",
      rest: ["--", "--session", "theirs"],
    });
  });

  test("a dangling --session with no value is passed through, not swallowed", () => {
    // Eating it would leave the user staring at a flag that vanished.
    expect(parseClaudeOptions(["--session"])).toEqual({ rest: ["--session"] });
  });

  test("two agents in ONE directory get different session names", () => {
    // The reason the flag exists. Same cwd, same config, different names.
    const config = { ...emptyConfig(), runtimeId: "one-box" };
    const a = sessionNameFromConfig(config, "/tmp/shared", "brosnan");
    const b = sessionNameFromConfig(config, "/tmp/shared", "moore");
    expect(a).not.toBe(b);
    // CONTROL: with no override they collide — which is the default rule
    // working as designed, and why the override is needed at all.
    expect(sessionNameFromConfig(config, "/tmp/shared")).toBe(sessionNameFromConfig(config, "/tmp/shared"));
  });
});

/* ------------------------------------------------------------------------- */
/* The `suite` alias is gone (0.10.0)                                         */
/* ------------------------------------------------------------------------- */

describe("no suite alias", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

  /** Run the real CLI in a scratch HOME with no agents. */
  function invoke(args: string[], extra: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "burrow-cli-noalias."));
    try {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        cwd: home,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, NO_COLOR: "1", ...extra },
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("--help does not mention a suite alias", () => {
    expect(usage()).not.toMatch(/alias/i);
    expect(usage()).not.toMatch(/\bsuite\b/);
  });

  // A 0.9.0 `suite` launcher left on disk still exports BURROW_INVOKED_AS=suite
  // into this library. It is ignored: same bytes on both streams as without it.
  for (const args of [["--version"], ["status", "--json"], ["--help"], ["nope"]]) {
    test(`\`${args.join(" ")}\`: a stale BURROW_INVOKED_AS=suite changes nothing`, () => {
      const plain = invoke(args);
      const stale = invoke(args, { BURROW_INVOKED_AS: "suite" });
      expect(stale).toEqual(plain);
      expect(stale.stderr).not.toContain("now burrow");
    });
  }
});
