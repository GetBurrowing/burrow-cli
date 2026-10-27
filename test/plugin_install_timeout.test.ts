/**
 * `bun install` in the plugin checkout is bounded (0.17.1). A stalled registry
 * connection pool once left a fresh install in `starting` forever while a
 * manual install took milliseconds. The runner is faked: one that never
 * settles, one that hangs then succeeds. Timeouts are tiny so the suite is fast;
 * the hang test would sit until the runner's own test timeout without the bound.
 */
import { describe, expect, test } from "bun:test";
import { installDependencies } from "../src/claude_wiring.ts";
import { createStore, spawnWithSecrets } from "../src/secrets.ts";

type R = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout = "4 packages installed"): R => ({ exitCode: 0, stdout, stderr: "" });

function harness(env: Record<string, string>, behave: (n: number, argv: string[], signal?: AbortSignal) => Promise<R>) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const run = (argv: string[], o?: { signal?: AbortSignal }) => {
    calls.push(argv);
    signals.push(o?.signal);
    return behave(calls.length, argv, o?.signal);
  };
  const deps = {
    env: { BURROW_BUN_INSTALL_BACKOFF_MS: "1", ...env },
    run: run as never,
    out: (l: string) => lines.push(l),
  };
  return { deps, calls, lines, signals };
}

const never = (): Promise<R> => new Promise(() => {});

describe("installDependencies", () => {
  test("passes --network-concurrency=16 and succeeds first try", async () => {
    const h = harness({}, async () => ok());
    await installDependencies(h.deps, "/x");
    expect(h.calls).toEqual([["bun", "install", "--network-concurrency=16"]]);
    expect(h.lines.join("\n")).toContain("attempt 1/3");
  });

  test("a hung install is abandoned at the deadline, killed, and reported after all attempts", async () => {
    const h = harness({ BURROW_BUN_INSTALL_TIMEOUT_MS: "40" }, never);
    // try/catch, not `.rejects`: bun's `.rejects` on a never-settling promise blocks past the test timeout.
    let err: unknown = null;
    try {
      await installDependencies(h.deps, "/x");
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/after 3 attempts[\s\S]*attempt 3: timed out/);
    expect(h.calls.length).toBe(3);
    expect(h.signals.every((s) => s?.aborted === true)).toBe(true);
    expect(h.lines.filter((l) => l.includes("timed out")).length).toBe(3);
  }, 5_000);

  test("hangs once, then succeeds on the second try", async () => {
    const h = harness({ BURROW_BUN_INSTALL_TIMEOUT_MS: "40" }, (n) => (n === 1 ? never() : Promise.resolve(ok())));
    await installDependencies(h.deps, "/x");
    expect(h.calls.length).toBe(2);
    const text = h.lines.join("\n");
    expect(text).toContain("attempt 1/3");
    expect(text).toContain("timed out");
    expect(text).toContain("attempt 2/3");
    expect(text).toContain("ok in");
  }, 5_000);

  test("retries are configurable and a nonzero exit counts as a failed attempt", async () => {
    const h = harness({ BURROW_BUN_INSTALL_RETRIES: "0" }, async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    await expect(installDependencies(h.deps, "/x")).rejects.toThrow(/after 1 attempts[\s\S]*exit 1 \(boom\)/);
    expect(h.calls.length).toBe(1);
  });

  test("an older bun without the flag is retried without it, not failed", async () => {
    const h = harness({}, async (_n, argv) =>
      argv.some((a) => a.startsWith("--network-concurrency")) ? { exitCode: 1, stdout: "", stderr: "error: Unknown option" } : ok(),
    );
    await installDependencies(h.deps, "/x");
    expect(h.calls[1]).toEqual(["bun", "install"]);
  });
});

describe("spawnWithSecrets signal", () => {
  test("aborting kills the whole process tree, including a grandchild holding the pipes", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const started = Date.now();
    const r = await spawnWithSecrets(["sh", "-c", "sleep 30 & sleep 30; wait"], createStore(), { signal: ctl.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.exitCode).toBe(143);
  }, 10_000);
});
