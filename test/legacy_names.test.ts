/**
 * The 0.11.0 rename of the last `suite` names (src/legacy_names.ts): the pure
 * transforms, and the guard that keeps the old Claude Code spellings in that
 * one module. The end-to-end start/attach/refusal cases are in
 * per_folder_wiring.test.ts ("0.11.0: ..."). Every value is fake.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  HERMES_MCP_RENAME,
  HERMES_PLUGIN_RENAME,
  HERMES_TOKEN_RENAME,
  hermesLegacyNames,
  pendingHermesRenames,
  LEGACY_CONTINUE_WRAPPER,
  LEGACY_DEV_CHANNEL,
  LegacyNameConflict,
  SERVER_RENAMES,
  configUrl,
  isLegacyContinueWrapper,
  pendingServerIds,
  registeredId,
  renamedConfig,
  renamedEnv,
  renamedIdList,
  renamedLaunchArgv,
  renamedServerMap,
  serverEntry,
} from "../src/legacy_names.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import { DEV_CHANNEL_ARGS, paneCommand } from "../src/commands/claude.ts";
import { CONTINUE_WRAPPER_NAME } from "../src/tmux.ts";
import { relaunchArgvRename } from "../src/commands/restore.ts";
import type { RosterEntry } from "../src/roster.ts";
import { MCP_SERVER_NAME, PLUGIN_NAME, TOKEN_RELPATH } from "../src/commands/hermes.ts";

describe("the names", () => {
  test("the new ids are the ones every writer uses; raw literals, not derived", () => {
    expect(SERVER_RENAMES).toEqual([
      ["suite-channel", "burrow-channel"],
      ["startup-suite", "burrow"],
    ]);
    expect([CHANNEL_SERVER, TOOLS_SERVER]).toEqual(["burrow-channel", "burrow"]);
    expect(DEV_CHANNEL_ARGS).toEqual(["--dangerously-load-development-channels", "server:burrow-channel"]);
    expect(CONTINUE_WRAPPER_NAME).toBe("burrow-claude-continue");
  });

  test("an interactive launch's pane command carries the new flag and wrapper, and no old spelling", () => {
    const argv = paneCommand([]);
    expect(argv).toContain("server:burrow-channel");
    expect(argv).toContain("burrow-claude-continue");
    expect(argv.join("\n")).not.toMatch(/suite-channel|suite-claude-continue/);
  });
});

describe("pure transforms", () => {
  test("renamedEnv: SUITE_X moves to BURROW_X; where both exist the BURROW_ value stays and the copy goes", () => {
    expect(renamedEnv({ SUITE_URL: "u", SUITE_TOKEN: "${T}", OTHER: "o" })).toEqual({ BURROW_URL: "u", BURROW_TOKEN: "${T}", OTHER: "o" });
    expect(renamedEnv({ BURROW_URL: "new", SUITE_URL: "old" })).toEqual({ BURROW_URL: "new" });
  });

  test("renamedServerMap keeps key order and every other entry; renames env only on the renamed entries", () => {
    const map = { xcode: { env: { SUITE_KEEP: "x" } }, "suite-channel": { env: { SUITE_URL: "u" } }, "startup-suite": { url: "h" } };
    const out = renamedServerMap(map, "f");
    expect(Object.keys(out)).toEqual(["xcode", "burrow-channel", "burrow"]);
    expect(out.xcode).toEqual({ env: { SUITE_KEEP: "x" } });
    expect(out["burrow-channel"]).toEqual({ env: { BURROW_URL: "u" } });
    expect(out.burrow).toEqual({ url: "h" });
  });

  test("an old id beside its new id is a conflict naming both; never merged", () => {
    expect(() => pendingServerIds({ "suite-channel": {}, "burrow-channel": {} }, "F")).toThrow(LegacyNameConflict);
    expect(() => pendingServerIds({ "suite-channel": {}, "burrow-channel": {} }, "F")).toThrow(/F holds both suite-channel and burrow-channel/);
    expect(() => renamedIdList(["startup-suite", "burrow"], "L")).toThrow(/holds both startup-suite and burrow/);
    expect(() => configUrl({ suiteUrl: "a", burrowUrl: "b" }, "C")).toThrow(/C holds both suiteUrl and burrowUrl/);
  });

  test("POSITIVE CONTROL: a map with only new ids, or only unrelated ones, needs nothing", () => {
    expect(pendingServerIds({ "burrow-channel": {}, burrow: {} }, "f")).toEqual([]);
    expect(pendingServerIds({ suite: {} }, "f")).toEqual([]);
    expect(pendingServerIds({ "startup-suite": {} }, "f")).toEqual([["startup-suite", "burrow"]]);
  });

  test("renamedConfig moves the key in place; configUrl reads either generation, read-only", () => {
    expect(Object.keys(renamedConfig({ dir: "/d", suiteUrl: "u", runtimeId: "r" }, "f"))).toEqual(["dir", "burrowUrl", "runtimeId"]);
    expect(configUrl({ suiteUrl: "u" })).toBe("u");
    expect(configUrl({ burrowUrl: "v" })).toBe("v");
    expect(configUrl({})).toBeUndefined();
  });

  test("serverEntry / registeredId: the new id, else the old one, else nothing", () => {
    expect(serverEntry({ burrow: 1, "startup-suite": 2 }, "burrow")).toBe(1);
    expect(serverEntry({ "startup-suite": 2 }, "burrow")).toBe(2);
    expect(serverEntry({ suite: 3 }, "burrow")).toBeUndefined();
    expect(registeredId({ "suite-channel": 1 }, "burrow-channel")).toBe("suite-channel");
    expect(registeredId({}, "burrow-channel")).toBe("burrow-channel");
  });

  test("renamedLaunchArgv replaces whole argv elements only", () => {
    const argv = ["sh", "-c", "echo server:suite-channel", LEGACY_CONTINUE_WRAPPER, "claude", "--x", LEGACY_DEV_CHANNEL, "server:suite-channel-2"];
    expect(renamedLaunchArgv(argv, "server:burrow-channel", "burrow-claude-continue")).toEqual([
      "sh",
      "-c",
      "echo server:suite-channel",
      "burrow-claude-continue",
      "claude",
      "--x",
      "server:burrow-channel",
      "server:suite-channel-2",
    ]);
  });

  test("restore: only a claude entry's argv is renamed; an already-renamed one is left as it is", () => {
    const base: RosterEntry = { session: "s", command: ["tmux", "new-session", LEGACY_DEV_CHANNEL], cwd: "/a", kind: "claude", recordedAt: "t" };
    expect(relaunchArgvRename(base)?.command).toEqual(["tmux", "new-session", "server:burrow-channel"]);
    expect(relaunchArgvRename({ ...base, kind: "deepseek" })).toBeNull();
    expect(relaunchArgvRename({ ...base, command: ["tmux", "new-session", "server:burrow-channel"] })).toBeNull();
  });

  test("the pre-0.11.0 fallback shell is still recognised for adoption, as a whole token", () => {
    expect(isLegacyContinueWrapper(`/bin/sh -c t0=1 ${LEGACY_CONTINUE_WRAPPER} claude`)).toBe(true);
    expect(isLegacyContinueWrapper("claude --dangerously-load-development-channels server:suite-channel")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* The old Claude Code spellings live in legacy_names.ts and nowhere else      */
/* ------------------------------------------------------------------------- */

const SRC = resolve(import.meta.dir, "..", "src");

/** A quoted old id, flag value or wrapper name on a code line. */
const OLD_LITERAL = /["'`](suite-channel|startup-suite|server:suite-channel|suite-claude-continue)["'`]/;

/**
 * Files that still spell an old id ON PURPOSE, each for a harness 0.11.0 does
 * not rename (it renames Claude Code's names only). Listed so the residue is a
 * reviewed fact, not a grep result.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  "legacy_names.ts": "the one module that spells the old names",
  "commands/openclaw.ts": "the OpenClaw plugin's own channel id",
};

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no other src file spells an old Claude Code name", () => {
  test("the pattern fires on the shapes it exists for (and not on a comment's prose)", () => {
    expect(OLD_LITERAL.test(`export const CHANNEL_SERVER = "suite-channel";`)).toBe(true);
    expect(OLD_LITERAL.test("`server:suite-channel`")).toBe(true);
    expect(OLD_LITERAL.test(`["sh", 'suite-claude-continue']`)).toBe(true);
    expect(OLD_LITERAL.test("the suite-channel MCP server")).toBe(false);
  });

  test("only the listed files carry one, and every listed file still does", () => {
    const hits = new Set<string>();
    for (const f of srcFiles(SRC)) {
      const rel = relative(SRC, f);
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line) => {
          if (/^\s*(\/\*|\*|\/\/)/.test(line)) return;
          if (OLD_LITERAL.test(line)) hits.add(rel);
        });
    }
    expect([...hits].filter((f) => OUT_OF_SCOPE[f] === undefined)).toEqual([]);
    // A listed file that no longer needs its exemption is removed from the list.
    expect(Object.keys(OUT_OF_SCOPE).filter((f) => !hits.has(f))).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Hermes (0.12.0)                                                           */
/* ------------------------------------------------------------------------- */

describe("the Hermes names (0.12.0)", () => {
  test("the new side of each pair is what the hermes adapter uses; raw literals", () => {
    expect(HERMES_MCP_RENAME).toEqual(["startup-suite", "burrow"]);
    expect(HERMES_PLUGIN_RENAME).toEqual(["startup-suite-platform", "burrow-platform"]);
    expect(HERMES_TOKEN_RENAME).toEqual([
      join("mcp-tokens", "startup-suite-platform.runtime-token"),
      join("mcp-tokens", "burrow-platform.runtime-token"),
    ]);
    expect([MCP_SERVER_NAME, PLUGIN_NAME, TOKEN_RELPATH]).toEqual([HERMES_MCP_RENAME[1], HERMES_PLUGIN_RENAME[1], HERMES_TOKEN_RENAME[1]]);
  });

  function home(files: Record<string, string>): string {
    const h = mkdtempSync(join(tmpdir(), `burrow-01a158c2-hermes-home-${process.pid}-`));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(h, rel, ".."), { recursive: true });
      writeFileSync(join(h, rel), body);
      chmodSync(join(h, rel), 0o600);
    }
    return h;
  }
  const OLD_TOKEN = join("mcp-tokens", "startup-suite-platform.runtime-token");
  const NEW_TOKEN = join("mcp-tokens", "burrow-platform.runtime-token");

  test("pending: each old name is planned once; a renamed or empty home plans nothing", () => {
    const h = home({ [OLD_TOKEN]: "t\n", "plugins/startup-suite-platform/plugin.yaml": "name: x\n" });
    try {
      const config = { mcp_servers: { "startup-suite": { command: "py" }, other: {} }, plugins: { enabled: ["startup-suite-platform"] } };
      expect(pendingHermesRenames(h, config).map((r) => [r.place, r.oldName, r.newName])).toEqual([
        ["mcp_server", "startup-suite", "burrow"],
        ["plugin", "startup-suite-platform", "burrow-platform"],
        ["token_file", OLD_TOKEN, NEW_TOKEN],
      ]);
      expect(hermesLegacyNames(h, config)).toHaveLength(4);
      // POSITIVE CONTROL for "nothing": the same home without the old names.
      const clean = home({ [NEW_TOKEN]: "t\n", "plugins/burrow-platform/plugin.yaml": "name: x\n" });
      const fresh = { mcp_servers: { burrow: {} }, plugins: { enabled: ["burrow-platform"] } };
      expect(pendingHermesRenames(clean, fresh)).toEqual([]);
      expect(hermesLegacyNames(clean, fresh)).toEqual([]);
      expect(pendingHermesRenames(clean, null)).toEqual([]);
      rmSync(clean, { recursive: true, force: true });
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("old beside new in any one place is a conflict naming the place and both names; the read-only lister never throws", () => {
    const h = home({ [OLD_TOKEN]: "a\n", [NEW_TOKEN]: "b\n" });
    try {
      expect(() => pendingHermesRenames(h, null)).toThrow(LegacyNameConflict);
      expect(() => pendingHermesRenames(h, null)).toThrow(`${join(h, "mcp-tokens")} holds both ${OLD_TOKEN} and ${NEW_TOKEN}; burrow 0.12.0 reads only`);
      expect(hermesLegacyNames(h, null)).toEqual([join(h, OLD_TOKEN)]);
      const both = { mcp_servers: { "startup-suite": {}, burrow: {} } };
      expect(() => pendingHermesRenames(h, both)).toThrow(`${join(h, "config.yaml")} mcp_servers holds both startup-suite and burrow`);
      const listed = { plugins: { disabled: ["burrow-platform", "startup-suite-platform"] } };
      expect(() => pendingHermesRenames(h, listed)).toThrow(`${join(h, "config.yaml")} plugins.disabled holds both startup-suite-platform and burrow-platform`);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("the hermes adapter spells no old Hermes name anywhere, comments included", () => {
    const has = (text: string): boolean => /startup-suite/.test(text);
    // POSITIVE CONTROL: the check fires on a comment and on a code literal.
    expect(has("// the startup-suite MCP id")).toBe(true);
    expect(has(`const X = "startup-suite-platform";`)).toBe(true);
    expect(has(readFileSync(resolve(SRC, "commands", "hermes.ts"), "utf8"))).toBe(false);
    expect(statSync(resolve(SRC, "commands", "hermes.ts")).size).toBeGreaterThan(0);
  });
});
