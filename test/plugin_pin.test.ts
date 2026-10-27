/**
 * The Claude Code channel plugin checkout is HELD AT A PIN.
 *
 * Before 0.9.0 an existing checkout was used as it was and never pulled
 * (claude_wiring.ts ensureCheckout), so a host stayed on the commit it first
 * cloned: hive's sat at b238164 (2026-07-31). `ensurePluginAtPin` moves a
 * clean, unreferenced checkout that is BEHIND the pin, and leaves every other
 * one exactly where it is, with a reason.
 *
 * The runner is faked in-process so every git call is counted, and HEAD lives
 * in a real scratch `.git/HEAD`, so "HEAD unchanged" is read from the file the
 * at-pin check itself reads. All values are invented.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPS_MARKER, ensurePluginAtPin, readHeadSha } from "../src/claude_wiring.ts";
import { CLAUDE_CODE_CHANNEL_REF, pluginRepo } from "../src/commands/init.ts";
import type { LiveProbe } from "../src/migrate.ts";

const PIN = "a77532e6623405c2eb9043d2d663a1e09a3e45f2";
const OLD = "b238164b238164b238164b238164b238164b2381";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "burrow-plugin-pin-"));
  roots.push(root);
  return join(root, "burrow-channel-claude-code");
}

/** A checkout on disk with HEAD at `head` (detached), src/index.ts, and node_modules. */
function checkoutAt(head: string, opts: { nodeModules?: boolean } = {}): string {
  const dir = scratch();
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "");
  writeFileSync(join(dir, ".git", "HEAD"), `${head}\n`);
  if (opts.nodeModules !== false) mkdirSync(join(dir, "node_modules"), { recursive: true });
  return dir;
}

interface Script {
  dirty?: boolean;
  diverged?: boolean;
  /** The pin is not in the object store until a fetch. */
  missing?: boolean;
  fetchFails?: boolean;
}

/** A fake runner: answers git like a checkout described by `script`, and logs every argv. */
function runner(dir: string, script: Script = {}) {
  const calls: string[][] = [];
  let fetched = false;
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const no = (code: number, stderr = "") => ({ exitCode: code, stdout: "", stderr });
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "bun") return ok("4 packages installed [1.00ms]");
    if (argv[0] !== "git") return ok();
    if (argv[1] === "clone") {
      const to = argv[3] as string;
      mkdirSync(join(to, ".git"), { recursive: true });
      mkdirSync(join(to, "src"), { recursive: true });
      writeFileSync(join(to, "src", "index.ts"), "");
      writeFileSync(join(to, ".git", "HEAD"), "ref: refs/heads/main\n");
      return ok();
    }
    const sub = argv[3];
    switch (sub) {
      case "rev-parse":
        return ok(`${readFileSync(join(dir, ".git", "HEAD"), "utf8").trim()}\n`);
      case "status":
        return ok(script.dirty === true ? " M src/index.ts\n" : "");
      case "cat-file":
        return script.missing === true && !fetched ? no(128, "fatal: Not a valid object name") : ok();
      case "fetch":
        if (script.fetchFails === true) return no(128, "fatal: could not read Username for 'https://github.com'");
        fetched = true;
        return ok();
      case "merge-base":
        return script.diverged === true ? no(1) : ok();
      case "checkout":
        writeFileSync(join(dir, ".git", "HEAD"), `${argv[argv.length - 1]}\n`);
        return ok();
      default:
        return ok();
    }
  };
  const git = () => calls.filter((a) => a[0] === "git");
  return { run, calls, git };
}

const NOT_LIVE: LiveProbe = () => ({ args: [], cwds: [] });
const deps = (run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>) => ({
  env: { HOME: "/nonexistent-home" },
  isTTY: false,
  out: () => {},
  run,
});
const head = (dir: string) => readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();

describe("the pin", () => {
  test("CLAUDE_CODE_CHANNEL_REF is a full commit: 0.4.1 on burrow-channel-claude-code main", () => {
    expect(CLAUDE_CODE_CHANNEL_REF).toBe(PIN);
  });

  test("the pin's DEPLOYER comment sits above it, as the openclaw and hermes pins' do", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "commands", "init.ts"), "utf8");
    const at = src.indexOf("export const CLAUDE_CODE_CHANNEL_REF");
    expect(src.slice(Math.max(0, at - 1200), at)).toContain("DEPLOYER: BUMP THIS BEFORE burrow-cli MERGES.");
    expect(src.slice(Math.max(0, at - 1200), at)).toContain("Pin a commit on main, never a branch tip");
  });
});

describe("ensurePluginAtPin", () => {
  test("behind the pin: checks out the pin (detached), THEN bun install, and records the pin", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir);
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE);
    expect(res).toEqual({ outcome: "advanced", problem: null });
    expect(head(dir)).toBe(PIN);
    const co = r.calls.findIndex((a) => a[0] === "git" && a[3] === "checkout");
    const bun = r.calls.findIndex((a) => a[0] === "bun" && a[1] === "install");
    expect(r.calls[co]).toEqual(["git", "-C", dir, "checkout", "--quiet", "--detach", PIN]);
    expect(co).toBeGreaterThanOrEqual(0);
    expect(bun).toBeGreaterThan(co);
    expect(readFileSync(join(dir, "node_modules", DEPS_MARKER), "utf8")).toBe(`${PIN}\n`);
    // The pin was already in the object store, so no network.
    expect(r.git().some((a) => a[3] === "fetch")).toBe(false);
  });

  test("at the pin: ZERO git calls and no bun install", async () => {
    const dir = checkoutAt(PIN);
    const r = runner(dir);
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, () => {
      throw new Error("the process table is not read at the pin");
    });
    expect(res).toEqual({ outcome: "at-pin", problem: null });
    expect(r.calls).toEqual([]);
  });

  test("POSITIVE CONTROL for the zero above: the same checkout behind the pin makes git calls", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir);
    await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE);
    expect(r.git().length).toBeGreaterThan(0);
  });

  test("at the pin through a branch ref (loose, then packed-refs): still zero git calls", async () => {
    const loose = checkoutAt(PIN);
    writeFileSync(join(loose, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(loose, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(loose, ".git", "refs", "heads", "main"), `${PIN}\n`);
    expect(readHeadSha(loose)).toBe(PIN);
    const packed = checkoutAt(PIN);
    writeFileSync(join(packed, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(packed, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${PIN} refs/heads/main\n`);
    expect(readHeadSha(packed)).toBe(PIN);
    for (const dir of [loose, packed]) {
      const r = runner(dir);
      expect((await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE)).outcome).toBe("at-pin");
      expect(r.calls).toEqual([]);
    }
  });

  test("at the pin but node_modules is missing: bun install only, still no git", async () => {
    const dir = checkoutAt(PIN, { nodeModules: false });
    const r = runner(dir);
    expect((await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE)).outcome).toBe("at-pin");
    expect(r.git()).toEqual([]);
    expect(r.calls).toEqual([["bun", "install", "--network-concurrency=16"]]);
    expect(readFileSync(join(dir, "node_modules", DEPS_MARKER), "utf8")).toBe(`${PIN}\n`);
  });

  test("dirty: held with a warning, HEAD unchanged, never checked out or reset", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir, { dirty: true });
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE);
    expect(res.outcome).toBe("held");
    expect(res.problem).toContain("uncommitted changes");
    expect(res.problem).toContain("never reset or forced");
    expect(head(dir)).toBe(OLD);
    expect(r.git().some((a) => ["checkout", "reset", "clean", "stash"].includes(a[3] as string))).toBe(false);
  });

  test("diverged (HEAD not an ancestor of the pin): held with a warning, HEAD unchanged", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir, { diverged: true });
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE);
    expect(res.outcome).toBe("held");
    expect(res.problem).toContain("not behind the pin");
    expect(head(dir)).toBe(OLD);
    expect(r.git().some((a) => ["checkout", "reset", "clean"].includes(a[3] as string))).toBe(false);
  });

  test("referenced by a live process: deferred with a warning, and git is never asked", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir);
    const live: LiveProbe = () => ({ args: [`bun ${dir}/src/index.ts`], cwds: [] });
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, live);
    expect(res.outcome).toBe("held");
    expect(res.problem).toContain("a running process uses it");
    expect(head(dir)).toBe(OLD);
    expect(r.calls).toEqual([]);
  });

  test("an unreadable process table counts as live: deferred", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir);
    expect((await ensurePluginAtPin(deps(r.run), dir, PIN, () => null)).outcome).toBe("held");
    expect(head(dir)).toBe(OLD);
  });

  test("the pin is fetched only when it is not in the object store", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir, { missing: true });
    expect((await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE)).outcome).toBe("advanced");
    const subs = r.git().map((a) => a[3]);
    expect(subs.indexOf("fetch")).toBeGreaterThan(subs.indexOf("cat-file"));
    expect(subs.indexOf("checkout")).toBeGreaterThan(subs.indexOf("fetch"));
    expect(head(dir)).toBe(PIN);
  });

  test("a failed fetch throws (the wiring warns and launches), HEAD unchanged", async () => {
    const dir = checkoutAt(OLD);
    const r = runner(dir, { missing: true, fetchFails: true });
    await expect(ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE)).rejects.toThrow("could not fetch");
    expect(head(dir)).toBe(OLD);
  });

  test("a fresh clone checks out the pin", async () => {
    const dir = scratch();
    const r = runner(dir);
    const res = await ensurePluginAtPin(deps(r.run), dir, PIN, NOT_LIVE);
    expect(res.outcome).toBe("cloned");
    expect(r.calls[0]).toEqual(["git", "clone", pluginRepo({ HOME: "/nonexistent-home" }), dir]);
    expect(r.calls).toContainEqual(["git", "-C", dir, "checkout", "--quiet", "--detach", PIN]);
    expect(head(dir)).toBe(PIN);
    expect(existsSync(join(dir, "node_modules", DEPS_MARKER))).toBe(true);
  });

  test("idempotent: a second run after advancing makes zero git calls", async () => {
    const dir = checkoutAt(OLD);
    await ensurePluginAtPin(deps(runner(dir).run), dir, PIN, NOT_LIVE);
    const again = runner(dir);
    expect((await ensurePluginAtPin(deps(again.run), dir, PIN, NOT_LIVE)).outcome).toBe("at-pin");
    expect(again.calls).toEqual([]);
  });
});
