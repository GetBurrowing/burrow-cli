/**
 * install.sh behaviour tests.
 *
 * Every run is against a scratch HOME with XDG_BIN_HOME / XDG_DATA_HOME
 * pointed inside it, so nothing touches the developer's machine. The
 * "download" is a real curl fetch of a file:// URL pointing at a tarball built
 * from this working tree, which exercises the same fetch/extract/stage/move
 * path the network install takes.
 *
 * All fixture values are invented. Nothing here is a real host, id or token.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

/*
 * The version is read from the manifest rather than pinned as a literal.
 *
 * Not circularity: the property under test is that all THREE surfaces — the
 * installer's banner, the POSIX launcher it renders, and the copy it stages —
 * agree with package.json, which is the single source of truth install.sh
 * itself reads. A literal here would assert nothing extra and would red every
 * one of these tests on an ordinary version bump, which is how a pin teaches
 * people to edit tests as a matter of routine.
 */
const VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

let workRoot: string;
let tarball: string;

/** Build a tarball of the working tree, laid out like a GitHub archive. */
beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "suite-cli-test."));
  const stage = join(workRoot, "stage");
  const pkgDir = join(stage, "suite-cli-main");
  mkdirSync(pkgDir, { recursive: true });
  // `assets` belongs here because a real GitHub archive contains it. Omitting
  // it made this fixture describe an archive that cannot exist, and that gap
  // is precisely what let the installer ship without assets/ unnoticed: the
  // tests could not have caught it, because the thing they installed from
  // never had the directory in the first place.
  for (const entry of ["install.sh", "package.json", "src", "bin", "assets"]) {
    const cp = spawnSync("cp", ["-R", join(REPO_ROOT, entry), join(pkgDir, entry)]);
    expect(cp.status).toBe(0);
  }
  tarball = join(workRoot, "suite-cli.tar.gz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", stage, "suite-cli-main"]);
  expect(tar.status).toBe(0);
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  home: string;
  /** `~/.local/bin/burrow`, the launcher. */
  dest: string;
  /** `~/.local/bin/suite`, the alias rendered from the same template. */
  alias: string;
}

/** The one stderr line the `suite` alias prints. */
const ALIAS_NOTICE = "suite: this command is now burrow; suite keeps working as an alias\n";

function makeHome(): string {
  const home = mkdtempSync(join(workRoot, "home."));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  return home;
}

/**
 * A PATH holding exactly the externals install.sh invokes — and no `gh`.
 *
 * The CI container (ubuntu:24.04, no gh installed) is the only leg of this
 * suite where GH_TOKEN goes unassigned through the whole fetch, which is how
 * a bare "$GH_TOKEN" under `set -u` shipped green from a dev box: on a machine
 * with gh on PATH, resolve_gh_token always assigns the variable (possibly to
 * an empty string) and the unset-parameter branch never runs. This fixture
 * reproduces the CI shape on ANY machine, so the bug it caught cannot pass
 * again just because the developer happens to have gh.
 */
function ghlessPath(): string {
  const bin = mkdtempSync(join(workRoot, "ghless-bin."));
  // `sh` itself belongs here too: Node resolves the spawned executable against
  // the child's env.PATH, so a PATH without sh fails the spawn before the
  // installer gets to run at all. gzip is here because `tar -z` execs it via
  // PATH rather than linking it in.
  for (const tool of ["sh", "uname", "mktemp", "mkdir", "tar", "gzip", "sed", "head", "cp", "mv", "rm", "chmod", "curl", "dirname"]) {
    const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (!resolved) throw new Error(`cannot build ghless PATH: ${tool} not found`);
    symlinkSync(resolved, join(bin, tool));
  }
  return bin;
}

function runInstaller(
  home: string,
  opts: { url?: string; stdin?: string; path?: string; urlVar?: string; env?: Record<string, string> } = {},
): RunResult {
  const url = opts.url ?? `file://${tarball}`;
  const result = spawnSync("sh", [INSTALL_SH], {
    input: opts.stdin ?? "",
    encoding: "utf8",
    env: {
      // A deliberately minimal environment: no inherited XDG_* or PATH
      // surprises from the developer's shell.
      PATH: opts.path ?? process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      // The legacy name by default: it is what core's agent-host and every
      // pre-rename `suite update` hand the installer. BURROW_ is covered below.
      [opts.urlVar ?? "SUITE_CLI_TARBALL_URL"]: url,
      ...opts.env,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    home,
    dest: join(home, ".local", "bin", "burrow"),
    alias: join(home, ".local", "bin", "suite"),
  };
}

describe("install.sh", () => {
  test("installs the entrypoint into a scratch HOME and exits 0", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
    expect(r.stdout).toContain(`burrow ${VERSION}`);
    // The library was staged too, not just the launcher.
    expect(existsSync(join(r.home, ".local", "share", "suite", "cli", "src", "cli.ts"))).toBe(true);
    // The installed entrypoint answers --version without needing bun.
    const v = spawnSync(r.dest, ["--version"], { encoding: "utf8" });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(VERSION);
  });

  test("ships assets/, which `suite deepseek` needs at runtime", () => {
    // Regression: the installer copied only src/ and package.json, so every
    // install and every `suite update` produced a CLI whose deepseek verb
    // died at the last moment with "the bundled federation plugin was not
    // found", naming a directory the installer had never created. The verb
    // materialises the plugin out of this tree on every run — that is how
    // upgrading the CLI upgrades the plugin — so its absence is not cosmetic.
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    const plugin = join(
      r.home, ".local", "share", "suite", "cli",
      "assets", "dsh-plugins", "suite-federation", "index.js",
    );
    expect(existsSync(plugin)).toBe(true);
  });

  test("a second run is idempotent", () => {
    const home = makeHome();
    const first = runInstaller(home);
    expect(first.status).toBe(0);
    const second = runInstaller(home);
    expect(second.status).toBe(0);
    expect(existsSync(second.dest)).toBe(true);
    // Same version present: announced as already installed, no prompt, and the
    // result is identical.
    expect(second.stdout).toContain("already installed");
    expect(second.stdout).not.toContain("replace it");
    const a = spawnSync(first.dest, ["--version"], { encoding: "utf8" }).stdout;
    const b = spawnSync(second.dest, ["--version"], { encoding: "utf8" }).stdout;
    expect(b).toBe(a);
  });

  test("names the existing version and prompts before replacing a different suite", () => {
    const home = makeHome();
    // The pre-rename shape: only `suite` exists, so it is what gets announced.
    const dest = join(home, ".local", "bin", "suite");
    // A pre-existing, different `suite` on the destination.
    writeFileSync(dest, '#!/bin/sh\nprintf "0.0.9\\n"\n');
    chmodSync(dest, 0o755);

    const declined = runInstaller(home, { stdin: "n\n" });
    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain("suite 0.0.9 is already installed");
    expect(declined.stdout).toContain("replace it");
    // Declining leaves the original in place, untouched.
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.0.9");

    const accepted = runInstaller(home, { stdin: "y\n" });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("suite 0.0.9 is already installed");
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(VERSION);
    expect(spawnSync(accepted.dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(VERSION);
  });

  test("a failed fetch leaves NO file at the destination and exits non-zero", () => {
    const home = makeHome();
    const r = runInstaller(home, {
      url: `file://${join(workRoot, "does-not-exist.tar.gz")}`,
    });
    expect(r.status).not.toBe(0);
    // The assertion that matters: absence, not merely a non-zero exit. A
    // partial file must never reach the destination.
    expect(existsSync(r.dest)).toBe(false);
    expect(existsSync(r.alias)).toBe(false);
    expect(existsSync(join(home, ".local", "share", "suite", "cli"))).toBe(false);
    expect(r.stderr).toContain("install failed");
  });

  test("a truncated archive also leaves NO file at the destination", () => {
    const home = makeHome();
    const partial = join(workRoot, "partial.tar.gz");
    writeFileSync(partial, " not really a tarball");
    const r = runInstaller(home, { url: `file://${partial}` });
    expect(r.status).not.toBe(0);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("the final line of successful output has zero leading whitespace", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toBe("burrow init");
    expect(last).toBe(last.trimStart());
  });

  test("runs to completion with no gh on PATH (the CI shape)", () => {
    // Regression, PR #13 red in CI 2026-08-31: fetch() read the bare
    // "$GH_TOKEN" under `set -u`. With gh absent — the shape of the CI
    // container — resolve_gh_token never assigns the variable, so dash died
    // instantly with "GH_TOKEN: parameter not set" and exit 2, seven tests
    // at once. Every dev run was green because gh on PATH sets the variable
    // (to a real token, or an empty string via `|| true`), so only CI could
    // see it. This test pins the CI shape to the dev box.
    const r = runInstaller(makeHome(), { path: ghlessPath() });
    expect(r.stderr).not.toContain("parameter not set");
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
  });

  /*
   * SUITE_GITHUB_OWNER, with SUITE_CLI_TARBALL_URL UNSET, so the installer
   * builds its own codeload URL. A stub `curl` first on a gh-less PATH records
   * the URL it was asked for and fails, so nothing reaches the network and
   * the installer stops at the fetch, naming the URL.
   */
  function runWithOwner(owner: string | undefined, ref?: string) {
    const env: Record<string, string> = {};
    if (owner !== undefined) env.SUITE_GITHUB_OWNER = owner;
    if (ref !== undefined) env.SUITE_CLI_REF = ref;
    return runWithEnv(env);
  }

  /** The same stubbed-curl run, with exactly the BURROW_/SUITE_ inputs given. */
  function runWithEnv(extra: Record<string, string>) {
    const home = makeHome();
    const stubDir = join(home, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const log = join(home, "curl.log");
    writeFileSync(join(stubDir, "curl"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>"${log}"\nexit 22\n`);
    chmodSync(join(stubDir, "curl"), 0o755);
    const env: Record<string, string> = {
      PATH: `${stubDir}:${ghlessPath()}`,
      HOME: home,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      ...extra,
    };
    const r = spawnSync("sh", [INSTALL_SH], { input: "", encoding: "utf8", env });
    return {
      status: r.status ?? -1,
      stderr: r.stderr ?? "",
      fetched: existsSync(log) ? readFileSync(log, "utf8") : null,
      dest: join(home, ".local", "bin", "burrow"),
      alias: join(home, ".local", "bin", "suite"),
    };
  }

  test("SUITE_GITHUB_OWNER names the org in the tarball URL the installer fetches", () => {
    const r = runWithOwner("GetBurrowing");
    const url = "https://codeload.github.com/GetBurrowing/suite-cli/tar.gz/refs/heads/main";
    expect(r.fetched).toContain(url);
    expect(r.stderr).toContain(`could not download suite-cli from ${url}`);
    expect(r.status).not.toBe(0);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("a SHA ref under the override uses codeload's SHA path", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(runWithOwner("GetBurrowing", sha).fetched).toContain(
      `https://codeload.github.com/GetBurrowing/suite-cli/tar.gz/${sha}`,
    );
  });

  test("CONTROL: unset and empty both mean the default org", () => {
    for (const owner of [undefined, ""]) {
      expect(runWithOwner(owner).fetched).toContain("https://codeload.github.com/Startup-Suite/suite-cli/tar.gz/refs/heads/main");
    }
  });

  for (const bad of ["../x", "a/b", "-x", "a".repeat(40), "a b", "x;id"]) {
    test(`an invalid owner ${JSON.stringify(bad)} exits non-zero BEFORE any fetch`, () => {
      const r = runWithOwner(bad);
      expect(r.status).not.toBe(0);
      expect(r.fetched).toBeNull();
      expect(r.stderr).toContain("SUITE_GITHUB_OWNER");
      expect(existsSync(r.dest)).toBe(false);
      expect(existsSync(r.alias)).toBe(false);
    });
  }

  test("refuses Windows by name", () => {
    // The refusal is driven through uname: a stub uname first on PATH reports
    // a Windows kernel, which is the only signal install.sh has.
    const home = makeHome();
    const stubDir = join(home, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "uname");
    writeFileSync(stub, '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n');
    chmodSync(stub, 0o755);
    const result = spawnSync("sh", [INSTALL_SH], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        XDG_BIN_HOME: join(home, ".local", "bin"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        SUITE_CLI_TARBALL_URL: `file://${tarball}`,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Windows is not supported");
    expect(existsSync(join(home, ".local", "bin", "suite"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "burrow"))).toBe(false);
  });

  test("never invokes sudo", async () => {
    const source = await Bun.file(INSTALL_SH).text();
    // sudo appearing as a command, rather than inside the message that
    // explains we never use it.
    expect(source).not.toMatch(/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+|\bexec\s+)sudo\s/m);
  });

  test("warns and prints the exact export line when the dir is not on PATH", () => {
    const r = runInstaller(makeHome());
    expect(r.stdout).toContain("is not on PATH");
    expect(r.stdout).toContain(`export PATH="${join(r.home, ".local", "bin")}:$PATH"`);
    // Even in the warning path, the next command is still the last line.
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1]).toBe("burrow init");
  });
  /* ------------------------------------------------------------------ */
  /* Two rendered launchers: `burrow`, and `suite` kept as an alias      */
  /* ------------------------------------------------------------------ */

  test("a cold install renders BOTH launchers as regular executable files, never a symlink", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    for (const path of [r.dest, r.alias]) {
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(statSync(path).mode & 0o111).toBe(0o111);
    }
    // Each one knows its own name; that is what a symlink could not carry.
    expect(readFileSync(r.dest, "utf8")).toContain('BURROW_INVOKED_AS="burrow"');
    expect(readFileSync(r.alias, "utf8")).toContain('BURROW_INVOKED_AS="suite"');
    // No placeholder survived rendering in either.
    for (const path of [r.dest, r.alias]) expect(readFileSync(path, "utf8")).not.toMatch(/@BURROW_[A-Z_]+@/);
  });

  test("`suite --version` stdout is byte-identical to `burrow --version`; the alias adds one stderr line", () => {
    // Machine-read: install.sh's own existing-install check and core's
    // agent-host (`/usr/local/bin/suite --version`) parse this stdout.
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    const burrow = spawnSync(r.dest, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    const suite = spawnSync(r.alias, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(burrow.status).toBe(0);
    expect(suite.status).toBe(0);
    expect(Buffer.from(suite.stdout).equals(Buffer.from(burrow.stdout))).toBe(true);
    expect(burrow.stdout).toBe(`${VERSION}\n`);
    expect(burrow.stderr).toBe("");
    expect(suite.stderr).toBe(ALIAS_NOTICE);
  });

  test("both launchers point at the SAME, unmoved lib dir <data>/suite/cli", () => {
    const r = runInstaller(makeHome());
    const lib = join(r.home, ".local", "share", "suite", "cli");
    expect(readFileSync(r.dest, "utf8")).toContain(`BURROW_LIB_DIR="${lib}"`);
    expect(readFileSync(r.alias, "utf8")).toContain(`BURROW_LIB_DIR="${lib}"`);
    expect(existsSync(join(lib, "src", "cli.ts"))).toBe(true);
    expect(existsSync(join(r.home, ".local", "share", "burrow"))).toBe(false);
  });

  test("a reinstall over itself is announced under `burrow`", () => {
    const home = makeHome();
    expect(runInstaller(home).status).toBe(0);
    const second = runInstaller(home);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`burrow ${VERSION} is already installed`);
  });

  /*
   * The version a pre-rename host reports. 0.7.3 is the last `suite`-only
   * release; while this branch's manifest is still 0.7.3 (the bump to 0.8.0 is
   * a later stage), an equal version would take the reinstall path instead of
   * the replace prompt under test, so the fixture steps back one patch then.
   */
  const OLD_VERSION = VERSION === "0.7.3" ? "0.7.2" : "0.7.3";

  test("an old 0.7.3-style host (only ~/.local/bin/suite, lib at ~/.local/share/suite/cli) upgrades in place", () => {
    const home = makeHome();
    const lib = join(home, ".local", "share", "suite", "cli");
    mkdirSync(join(lib, "src"), { recursive: true });
    writeFileSync(join(lib, "package.json"), `{"name":"suite-cli","version":"${OLD_VERSION}"}\n`);
    writeFileSync(join(lib, "src", "cli.ts"), "// the 0.7.3 library\n");
    const old = join(home, ".local", "bin", "suite");
    // The shape of a rendered 0.7.3 launcher: SUITE_* names, --version in sh.
    writeFileSync(
      old,
      `#!/bin/sh\nSUITE_LIB_DIR="${lib}"\nSUITE_VERSION="${OLD_VERSION}"\nexport SUITE_LIB_DIR SUITE_VERSION\n` +
        'case "${1:-}" in --version | -V) printf \'%s\\n\' "$SUITE_VERSION"; exit 0 ;; esac\n' +
        'exec bun "$SUITE_LIB_DIR/src/cli.ts" "$@"\n',
    );
    chmodSync(old, 0o755);
    const burrowPath = join(home, ".local", "bin", "burrow");
    expect(existsSync(burrowPath)).toBe(false);

    const r = runInstaller(home, { stdin: "y\n" });
    expect(r.status).toBe(0);
    // Announced by the name and version actually installed, and still asked.
    expect(r.stdout).toContain(`suite ${OLD_VERSION} is already installed`);
    expect(r.stdout).toContain(`replace it with ${VERSION}? [y/N]`);
    // Both files now exist; the old launcher was overwritten by the alias.
    expect(existsSync(r.dest)).toBe(true);
    expect(existsSync(r.alias)).toBe(true);
    expect(readFileSync(r.alias, "utf8")).not.toContain(`SUITE_VERSION="${OLD_VERSION}"`);
    expect(spawnSync(r.alias, ["--version"], { encoding: "utf8" }).stdout).toBe(`${VERSION}\n`);
    expect(spawnSync(r.dest, ["--version"], { encoding: "utf8" }).stdout).toBe(`${VERSION}\n`);
    // Same lib dir path, now holding the new library.
    expect(readFileSync(join(lib, "src", "cli.ts"), "utf8")).not.toContain("the 0.7.3 library");
    expect(readFileSync(r.dest, "utf8")).toContain(`BURROW_LIB_DIR="${lib}"`);
    expect(existsSync(join(home, ".local", "share", "burrow"))).toBe(false);
  });

  test("declining on an old host leaves the old `suite` alone and creates no `burrow`", () => {
    const home = makeHome();
    const old = join(home, ".local", "bin", "suite");
    writeFileSync(old, `#!/bin/sh\nprintf "${OLD_VERSION}\\n"\n`);
    chmodSync(old, 0o755);
    const r = runInstaller(home, { stdin: "n\n" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`keeping suite ${OLD_VERSION}`);
    expect(existsSync(r.dest)).toBe(false);
    expect(spawnSync(old, ["--version"], { encoding: "utf8" }).stdout).toBe(`${OLD_VERSION}\n`);
  });

  /* BURROW_* first, SUITE_* fallback, BURROW wins -------------------------- */

  const SHA_A = "0123456789abcdef0123456789abcdef01234567";
  const codeload = (owner: string, ref: string) =>
    `https://codeload.github.com/${owner}/suite-cli/tar.gz/${/^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`}`;

  test("ref: SUITE_CLI_REF alone is honoured (core's agent-host passes it)", () => {
    expect(runWithEnv({ SUITE_CLI_REF: SHA_A }).fetched).toContain(codeload("Startup-Suite", SHA_A));
  });

  test("ref: BURROW_CLI_REF alone is honoured", () => {
    expect(runWithEnv({ BURROW_CLI_REF: "next" }).fetched).toContain(codeload("Startup-Suite", "next"));
  });

  test("ref: both set, BURROW_CLI_REF wins and the SUITE value is never fetched", () => {
    const fetched = runWithEnv({ BURROW_CLI_REF: "main", SUITE_CLI_REF: SHA_A }).fetched ?? "";
    expect(fetched).toContain(codeload("Startup-Suite", "main"));
    expect(fetched).not.toContain(SHA_A);
  });

  test("ref: an empty BURROW_CLI_REF falls back to SUITE_CLI_REF", () => {
    expect(runWithEnv({ BURROW_CLI_REF: "", SUITE_CLI_REF: SHA_A }).fetched).toContain(codeload("Startup-Suite", SHA_A));
  });

  test("owner: SUITE_GITHUB_OWNER alone is honoured", () => {
    expect(runWithEnv({ SUITE_GITHUB_OWNER: "OldOrg" }).fetched).toContain(codeload("OldOrg", "main"));
  });

  test("owner: BURROW_GITHUB_OWNER alone is honoured", () => {
    expect(runWithEnv({ BURROW_GITHUB_OWNER: "NewOrg" }).fetched).toContain(codeload("NewOrg", "main"));
  });

  test("owner: both set, BURROW_GITHUB_OWNER wins", () => {
    const fetched = runWithEnv({ BURROW_GITHUB_OWNER: "NewOrg", SUITE_GITHUB_OWNER: "OldOrg" }).fetched ?? "";
    expect(fetched).toContain(codeload("NewOrg", "main"));
    expect(fetched).not.toContain("OldOrg");
  });

  test("owner: an invalid BURROW_GITHUB_OWNER is refused BY THAT NAME, never replaced by a valid SUITE one", () => {
    const r = runWithEnv({ BURROW_GITHUB_OWNER: "bad/owner", SUITE_GITHUB_OWNER: "Startup-Suite" });
    expect(r.status).not.toBe(0);
    expect(r.fetched).toBeNull();
    expect(r.stderr).toContain('BURROW_GITHUB_OWNER="bad/owner"');
    expect(r.stderr).not.toContain("SUITE_GITHUB_OWNER");
  });

  test("tarball URL: BURROW_CLI_TARBALL_URL alone installs", () => {
    const r = runInstaller(makeHome(), { urlVar: "BURROW_CLI_TARBALL_URL" });
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
  });

  test("tarball URL: both set, BURROW_CLI_TARBALL_URL wins", () => {
    // The SUITE value names a file that does not exist: if it were used, the
    // install would fail at the fetch.
    const r = runInstaller(makeHome(), {
      urlVar: "BURROW_CLI_TARBALL_URL",
      env: { SUITE_CLI_TARBALL_URL: `file://${join(workRoot, "not-this-one.tar.gz")}` },
    });
    expect(r.status).toBe(0);
    expect(existsSync(r.alias)).toBe(true);
  });
});
