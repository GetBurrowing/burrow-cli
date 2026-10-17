/**
 * `suite update`.
 *
 * The thing worth testing here is not "does it run an installer" — it is that
 * the REF reaches BOTH halves. `install.sh` defaults `SUITE_CLI_REF` to `main`
 * and infers nothing from the URL it was downloaded from, so an update that
 * fetches the installer from a tag but forgets to export the ref installs
 * `main` while looking correct. That failure is invisible from the outside,
 * which is why it is pinned directly rather than through an install.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REF,
  FETCHERS,
  REQUIRED_TOOLS,
  UPDATE_REFUSED_EXIT,
  announceLines,
  installerUrl,
  refIsSafe,
  resolveRef,
  SIGPIPE_EXIT,
  runUpdate,
  updateArgv,
  type UpdateDeps,
} from "../src/commands/update.ts";
import { VERSION } from "../src/version.ts";
import { parse, usage } from "../src/cli.ts";

/** A box where everything the update needs is present. */
function deps(over: Partial<UpdateDeps> = {}): UpdateDeps & {
  stdout: string[];
  stderr: string[];
  ran: string[][];
} {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const base: UpdateDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    which: (name) => (["curl", "wget", "tar", "sh"].includes(name) ? `/usr/bin/${name}` : null),
    exec: async (argv) => {
      ran.push(argv);
      return 0;
    },
    env: {},
    ...over,
  };
  // NOT `out`/`err`: those names collide with UpdateDeps' own function fields,
  // and Object.assign would replace the writers with the arrays — every call
  // would then throw rather than record.
  return Object.assign(base, { stdout: out, stderr: err, ran });
}

describe("the ref reaches both halves", () => {
  test("default: URL and SUITE_CLI_REF both say main", () => {
    const argv = updateArgv(DEFAULT_REF);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).toContain(`/${DEFAULT_REF}/install.sh`);
    expect(argv[2]).toContain(`SUITE_CLI_REF='${DEFAULT_REF}'`);
  });

  test("a tag: the exported ref matches the URL, not main", () => {
    // THE BUG THIS PINS: install.sh defaults SUITE_CLI_REF to main. Fetching
    // v9.9.9's installer without exporting the ref installs main and prints a
    // successful-looking install of the wrong thing.
    const script = updateArgv("v9.9.9")[2] ?? "";
    expect(script).toContain("/v9.9.9/install.sh");
    expect(script).toContain("SUITE_CLI_REF='v9.9.9'");
    expect(script).not.toContain(`SUITE_CLI_REF='${DEFAULT_REF}'`);
  });

  test("wget is used when curl is absent, and it still carries the ref", () => {
    // A box with only wget must not be handed a curl command line.
    const script = updateArgv("v1.2.3", "wget")[2] ?? "";
    expect(script).toContain("wget -q ");
    expect(script).not.toContain("curl ");
    expect(script).toContain("SUITE_CLI_REF='v1.2.3'");
  });

  test("resolveRef: env override, empty treated as unset", () => {
    expect(resolveRef({})).toBe(DEFAULT_REF);
    expect(resolveRef({ SUITE_CLI_REF: "" })).toBe(DEFAULT_REF);
    expect(resolveRef({ SUITE_CLI_REF: "release/1.0" })).toBe("release/1.0");
  });

  test("resolveRef: BURROW_CLI_REF is read first and wins; an empty one falls back", () => {
    expect(resolveRef({ BURROW_CLI_REF: "next" })).toBe("next");
    expect(resolveRef({ BURROW_CLI_REF: "next", SUITE_CLI_REF: "old" })).toBe("next");
    expect(resolveRef({ BURROW_CLI_REF: "", SUITE_CLI_REF: "old" })).toBe("old");
  });
});

describe("a ref that is not a ref is refused, not quoted-and-hoped", () => {
  test("shell metacharacters and traversal are rejected", () => {
    for (const bad of [
      "main'; rm -rf ~; echo '",
      "main`whoami`",
      "main$(id)",
      "../../etc/passwd",
      "a..b",
      "-leading-dash",
      "",
      "main\nsecond",
    ]) {
      expect(refIsSafe(bad)).toBe(false);
    }
  });

  test("CONTROL: ordinary refs are accepted", () => {
    // Without this half, a predicate that returned false for everything would
    // pass the case above and refuse every real update.
    for (const good of ["main", "v0.2.0", "release/1.0", "hotfix/suite-participation-flags", "89d1639"]) {
      expect(refIsSafe(good)).toBe(true);
    }
  });

  test("a refused ref runs NOTHING and says which value it refused", async () => {
    const d = deps({ env: { SUITE_CLI_REF: "main; rm -rf ~" } });
    const code = await runUpdate(d);
    expect(code).toBe(UPDATE_REFUSED_EXIT);
    expect(d.ran).toEqual([]);
    expect(d.stderr.join("\n")).toContain("main; rm -rf ~");
  });
});

describe("preconditions are named, and named before the announcement", () => {
  test("no fetcher: refuses, names curl and wget, runs nothing, announces nothing", async () => {
    const d = deps({ which: (n) => (n === "curl" || n === "wget" ? null : `/usr/bin/${n}`) });
    const code = await runUpdate(d);
    expect(code).toBe(UPDATE_REFUSED_EXIT);
    expect(d.ran).toEqual([]);
    // Saying "updating suite…" and then not updating is worse than refusing.
    expect(d.stdout).toEqual([]);
    for (const tool of FETCHERS) expect(d.stderr.join("\n")).toContain(tool);
  });

  test("missing tar: refuses and names tar", async () => {
    const d = deps({ which: (n) => (n === "tar" ? null : `/usr/bin/${n}`) });
    expect(await runUpdate(d)).toBe(UPDATE_REFUSED_EXIT);
    expect(d.stderr.join("\n")).toContain("tar");
    expect(d.ran).toEqual([]);
  });

  test("CONTROL: with every tool present it proceeds", async () => {
    // The half that kills a guard which refuses unconditionally.
    const d = deps();
    expect(await runUpdate(d)).toBe(0);
    expect(d.ran.length).toBe(1);
    expect(REQUIRED_TOOLS.length).toBeGreaterThan(0);
  });
});

describe("nothing silent", () => {
  test("the URL about to be piped into a shell is printed first", async () => {
    const d = deps();
    await runUpdate(d);
    // The first line may be a "resolved ref to sha" message; find the announcement.
    const announcement = d.stdout.find((l) => l.includes(installerUrl(DEFAULT_REF)));
    expect(announcement).toBeDefined();
    expect(announcement).toContain(VERSION);
  });

  test("a non-default ref is called out; the default is not noise", () => {
    expect(announceLines("v1.2.3")[0]).toContain("(ref v1.2.3)");
    expect(announceLines(DEFAULT_REF)[0]).not.toContain("(ref");
  });

  test("the installer's own replace prompt is NOT auto-answered", () => {
    // An update that silently overwrites is exactly what that prompt exists to
    // prevent, so no `yes |`, no `-y`, no here-string feeding it a reply.
    const script = updateArgv(DEFAULT_REF)[2] ?? "";
    expect(script).not.toContain("yes ");
    expect(script).not.toContain("<<");
    expect(script).not.toContain("printf 'y");
  });
});

describe("the verb is wired into the CLI", () => {
  test("parse routes it, with no arguments of its own", () => {
    expect(parse(["update"])).toEqual({ verb: "update", args: [] });
    // Unknown verbs still fall through — the control for "the set grew".
    expect(parse(["updatex"]).verb).toBe(null);
  });

  test("usage lists it", () => {
    expect(usage()).toContain("update");
  });
});

describe("the update exits with the installer's own code", () => {
  test("a failed install is reported as failed, not swallowed", async () => {
    const d = deps({ exec: async () => 3 });
    expect(await runUpdate(d)).toBe(3);
    expect(d.stderr.join(" ")).toContain("exited 3");
  });

  /**
   * `suite update | head` — the reader exits, the installer dies of SIGPIPE
   * partway, and every word explaining what was happening went into the pipe
   * that just closed. What is left on screen is the announcement with no
   * ending, which reads as success. Found by noticing the deployed file did
   * not contain the change that had just been "installed".
   */
  test("a cut-off install says so on STDERR, where a closed pipe cannot eat it", async () => {
    const d = deps({ exec: async () => SIGPIPE_EXIT });
    expect(await runUpdate(d)).toBe(SIGPIPE_EXIT);
    const said = d.stderr.join(" ");
    expect(said).toContain("NOTHING WAS INSTALLED");
    expect(said).toContain("piped");
    // The reassurance matters as much as the alarm: the user is on the old
    // version and it still works, because install.sh swaps only at the end.
    expect(said).toContain("previous version is intact");
  });

  test("a successful install says nothing on stderr", async () => {
    const d = deps({ exec: async () => 0 });
    expect(await runUpdate(d)).toBe(0);
    expect(d.stderr).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Both generations of name reach the installer                              */
/* ------------------------------------------------------------------------- */

describe("the installer gets BURROW_* AND SUITE_* names, one value per pair", () => {
  const NAMES = ["BURROW_GITHUB_OWNER", "BURROW_CLI_REF", "SUITE_GITHUB_OWNER", "SUITE_CLI_REF"];

  /** Every `NAME='value'` assignment in the script, in order. */
  const assignments = (script: string) => [...script.matchAll(/\b([A-Z_]+)='([^']*)'/g)].map((m) => [m[1], m[2]]);

  for (const fetcher of FETCHERS) {
    test(`${fetcher}: all four names, each exactly once, one value per pair`, () => {
      const script = updateArgv("v9.9.9", fetcher, { BURROW_GITHUB_OWNER: "NewOrg" })[2] ?? "";
      const pairs = assignments(script).filter(([n]) => NAMES.includes(n ?? ""));
      expect(pairs).toEqual([
        ["BURROW_GITHUB_OWNER", "NewOrg"],
        ["BURROW_CLI_REF", "v9.9.9"],
        ["SUITE_GITHUB_OWNER", "NewOrg"],
        ["SUITE_CLI_REF", "v9.9.9"],
      ]);
    });
  }

  test("SUITE_GITHUB_OWNER as the only input still reaches both names", () => {
    const script = updateArgv("main", "curl", { SUITE_GITHUB_OWNER: "OldOrg" })[2] ?? "";
    expect(script).toContain("BURROW_GITHUB_OWNER='OldOrg'");
    expect(script).toContain("SUITE_GITHUB_OWNER='OldOrg'");
  });

  test("the temp installer is a per-process burrow path, not the shared /tmp/suite-install.sh", () => {
    const script = updateArgv(DEFAULT_REF)[2] ?? "";
    expect(script).toContain("/tmp/burrow-install.sh.$$");
    expect(script).not.toContain("/tmp/suite-install.sh");
  });

  /**
   * The argv run for real against a stub `curl` that "downloads" an installer
   * which prints the four names it was handed, then exits 7. Proves an OLD
   * installer (one that reads only SUITE_*) is honoured, that the installer's
   * exit code survives the cleanup, and that the temp file is gone afterwards.
   */
  test("run for real: an old SUITE-only installer sees the pin; its exit code and cleanup hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "burrow-update-argv."));
    try {
      const body = join(dir, "installer.sh");
      writeFileSync(
        body,
        '#!/bin/sh\nprintf "%s|%s|%s|%s|%s\\n" "$BURROW_GITHUB_OWNER" "$BURROW_CLI_REF" "$SUITE_GITHUB_OWNER" "$SUITE_CLI_REF" "$0"\nexit 7\n',
      );
      writeFileSync(
        join(dir, "curl"),
        `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\ncat ${JSON.stringify(body)} >"$out"\n`,
      );
      chmodSync(join(dir, "curl"), 0o755);
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(dir, "gh"), 0o755);
      const argv = updateArgv("v1.2.3", "curl", { BURROW_GITHUB_OWNER: "NewOrg", SUITE_GITHUB_OWNER: "OldOrg" });
      const r = spawnSync(argv[0] ?? "sh", argv.slice(1), {
        encoding: "utf8",
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      });
      expect(r.status).toBe(7);
      const [owner, ref, legacyOwner, legacyRef, path] = (r.stdout ?? "").trim().split("|");
      expect([owner, ref, legacyOwner, legacyRef]).toEqual(["NewOrg", "v1.2.3", "NewOrg", "v1.2.3"]);
      expect(path).toMatch(/^\/tmp\/burrow-install\.sh\.\d+$/);
      expect(existsSync(path ?? "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused ref names the variable that supplied it", async () => {
    const viaBurrow = deps({ env: { BURROW_CLI_REF: "main; id", SUITE_CLI_REF: "main" } });
    expect(await runUpdate(viaBurrow)).toBe(UPDATE_REFUSED_EXIT);
    expect(viaBurrow.stderr.join("\n")).toContain('BURROW_CLI_REF="main; id"');
    const viaSuite = deps({ env: { SUITE_CLI_REF: "main; id" } });
    expect(await runUpdate(viaSuite)).toBe(UPDATE_REFUSED_EXIT);
    expect(viaSuite.stderr.join("\n")).toContain('SUITE_CLI_REF="main; id"');
    expect(viaSuite.stderr.join("\n")).toContain("burrow: refusing");
  });

  test("the announcement says burrow", () => {
    expect(announceLines(DEFAULT_REF)[0]).toStartWith(`updating burrow ${VERSION}`);
  });
});
