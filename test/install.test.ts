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
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
  /** `~/.local/bin/suite`: where 0.8-0.9 put the alias. 0.10.0 never writes it. */
  alias: string;
}

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

/*
 * EVERY install.sh run goes through runInstallSh, under a watchdog.
 *
 * A run takes ~0.7 s. CI run 39327111099 (2026-10-19) had one block for 361 s
 * with no output, cause unknown; the test then failed as a bare `status -1`.
 * The watchdog bounds a run at STALL_SECONDS (~80x normal) and, if it fires,
 * records what was STILL RUNNING under the installer before killing that whole
 * tree, so the failure names the stalled step (e.g. `bun install
 * --production`, curl, tar) along with the tail of the installer's own output.
 *
 * stdin is handed to the installer through fd 3: a non-interactive sh points a
 * background job's stdin at /dev/null before any `<&0` is applied.
 */
const STALL_SECONDS = 60;
const WATCHDOG = [
  'installer=$1 log=$2 secs=$3 dogpath=$4',
  'exec 3<&0',
  'sh "$installer" <&3 3<&- &',
  'child=$!',
  '(',
  '  PATH=$dogpath',
  '  desc() { for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" \'$2 == p { print $1 }\'); do echo "$c"; desc "$c"; done; }',
  '  trap \'kill "$s" 2>/dev/null; exit 0\' TERM',
  '  sleep "$secs" & s=$!',
  '  wait "$s"',
  '  if kill -0 "$child" 2>/dev/null; then',
  '    tree=$(desc "$child")',
  '    { echo "child $child"; ps -A -o pid= -o ppid= -o etime= -o args=; } > "$log"',
  '    kill -9 $tree "$child" 2>/dev/null',
  '  fi',
  ') </dev/null >/dev/null 2>&1 &',
  'dog=$!',
  'exec 3<&-',
  'wait "$child"; rc=$?',
  'kill "$dog" 2>/dev/null',
  'exit "$rc"',
].join("\n");

/** The processes under `root` in a `ps -o pid= -o ppid= -o etime= -o args=` listing, as "etime args" lines. */
function descendants(listing: string, root: number): string[] {
  const rows = listing
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], args: m[4] }));
  const out: string[] = [];
  const walk = (pid: number): void => {
    for (const r of rows.filter((x) => x.ppid === pid)) {
      out.push(`${r.etime}  ${r.args}`);
      walk(r.pid);
    }
  };
  walk(root);
  return out;
}

function runInstallSh(
  env: Record<string, string | undefined>,
  input = "",
  { script = INSTALL_SH, stallSeconds = STALL_SECONDS }: { script?: string; stallSeconds?: number } = {},
): SpawnSyncReturns<string> {
  const log = join(mkdtempSync(join(tmpdir(), "install-stall.")), "stall.txt");
  const r = spawnSync("sh", ["-c", WATCHDOG, "install-watchdog", script, log, String(stallSeconds), "/usr/bin:/bin"], {
    input,
    encoding: "utf8",
    env,
    // Backstop only: the watchdog fires first and says why.
    timeout: (stallSeconds + 30) * 1000,
    killSignal: "SIGKILL",
  });
  if (existsSync(log)) {
    const text = readFileSync(log, "utf8");
    const child = Number(/^child (\d+)/.exec(text)?.[1] ?? "-1");
    const tail = (t: string | null | undefined): string => (t ?? "").split("\n").slice(-15).join("\n");
    throw new Error(
      [
        `install.sh stalled: still running after ${stallSeconds}s, killed. Still running under it:`,
        ...descendants(text, child).map((l) => `  ${l}`),
        "--- installer stdout (tail) ---",
        tail(r.stdout),
        "--- installer stderr (tail) ---",
        tail(r.stderr),
      ].join("\n"),
    );
  }
  if (r.error !== undefined) throw r.error;
  return r;
}

function runInstaller(
  home: string,
  opts: { url?: string; stdin?: string; path?: string; urlVar?: string; env?: Record<string, string> } = {},
): RunResult {
  const url = opts.url ?? `file://${tarball}`;
  const result = runInstallSh(
    {
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
    opts.stdin ?? "",
  );
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
  test("the watchdog: a stalled installer fails fast and names what was still running", () => {
    // A stand-in installer that prints, then hangs in a child the way a stuck
    // `bun install` would. Stall bound 2 s instead of 60.
    const dir = mkdtempSync(join(tmpdir(), "install-stall-control."));
    const fake = join(dir, "install.sh");
    writeFileSync(fake, '#!/bin/sh\nprintf "staging\\n"\nsh -c "sleep 300; :" \nprintf "never\\n"\n');
    const started = Date.now();
    let message = "";
    try {
      runInstallSh({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, "", { script: fake, stallSeconds: 2 });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(message).toContain("install.sh stalled: still running after 2s");
    expect(message).toContain("sleep 300");
    expect(message).toContain("staging");
    expect(message).not.toContain("never");
    // Direction control: a run that finishes is returned, not reported, and
    // stdin still reaches the installer.
    const echo = join(dir, "echo.sh");
    writeFileSync(echo, '#!/bin/sh\nIFS= read -r line; printf "got:%s\\n" "$line"\n');
    const ok = runInstallSh({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, "y\n", { script: echo, stallSeconds: 2 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("got:y\n");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("installs the entrypoint into a scratch HOME and exits 0", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
    expect(r.stdout).toContain(`burrow ${VERSION}`);
    // The library was staged too, not just the launcher.
    expect(existsSync(join(r.home, ".local", "share", "burrow", "cli", "src", "cli.ts"))).toBe(true);
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
      r.home, ".local", "share", "burrow", "cli",
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

  test("names the existing version and prompts before replacing a different burrow", () => {
    const home = makeHome();
    const dest = join(home, ".local", "bin", "burrow");
    // A pre-existing, different `burrow` on the destination.
    writeFileSync(dest, '#!/bin/sh\nprintf "0.0.9\\n"\n');
    chmodSync(dest, 0o755);

    const declined = runInstaller(home, { stdin: "n\n" });
    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain("burrow 0.0.9 is already installed");
    expect(declined.stdout).toContain("replace it");
    // Declining leaves the original in place, untouched.
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.0.9");

    const accepted = runInstaller(home, { stdin: "y\n" });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("burrow 0.0.9 is already installed");
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(VERSION);
    expect(existsSync(accepted.alias)).toBe(false);
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
    const r = runInstallSh(env);
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
    // burrow-cli first: the stub's failure carries no status, so it is not a
    // 404 and the installer stops there rather than trying suite-cli.
    const url = "https://codeload.github.com/GetBurrowing/burrow-cli/tar.gz/refs/heads/main";
    expect(r.fetched).toContain(url);
    expect(r.stderr).toContain(`could not download burrow-cli from ${url}`);
    expect(r.status).not.toBe(0);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("a SHA ref under the override uses codeload's SHA path", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(runWithOwner("GetBurrowing", sha).fetched).toContain(
      `https://codeload.github.com/GetBurrowing/burrow-cli/tar.gz/${sha}`,
    );
  });

  test("CONTROL: unset and empty both mean the default org", () => {
    for (const owner of [undefined, ""]) {
      expect(runWithOwner(owner).fetched).toContain("https://codeload.github.com/Startup-Suite/burrow-cli/tar.gz/refs/heads/main");
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
    const result = runInstallSh({
      PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      SUITE_CLI_TARBALL_URL: `file://${tarball}`,
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
  /* One rendered launcher, `burrow`; no `suite` alias since 0.10.0      */
  /* ------------------------------------------------------------------ */

  test("a cold install renders `burrow` as a regular executable file and writes no `suite`", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    expect(lstatSync(r.dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(r.dest).isFile()).toBe(true);
    expect(statSync(r.dest).mode & 0o111).toBe(0o111);
    expect(readFileSync(r.dest, "utf8")).not.toMatch(/@BURROW_[A-Z_]+@/);
    expect(readFileSync(r.dest, "utf8")).not.toContain("BURROW_INVOKED_AS");
    expect(existsSync(r.alias)).toBe(false);
    expect(r.stdout).not.toContain("(alias)");
  });

  test("`burrow --version` prints the version alone, nothing on stderr", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    const burrow = spawnSync(r.dest, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(burrow.status).toBe(0);
    expect(burrow.stdout).toBe(`${VERSION}\n`);
    expect(burrow.stderr).toBe("");
  });

  test("the launcher points at <data>/burrow/cli", () => {
    const r = runInstaller(makeHome());
    const lib = join(r.home, ".local", "share", "burrow", "cli");
    expect(readFileSync(r.dest, "utf8")).toContain(`BURROW_LIB_DIR="${lib}"`);
    expect(existsSync(join(lib, "src", "cli.ts"))).toBe(true);
    expect(existsSync(join(r.home, ".local", "share", "suite"))).toBe(false);
  });

  test("XDG_DATA_HOME puts the lib at $XDG_DATA_HOME/burrow/cli", () => {
    const home = makeHome();
    const xdg = join(home, "xdg-data");
    const r = runInstaller(home, { env: { XDG_DATA_HOME: xdg } });
    expect(r.status).toBe(0);
    expect(readFileSync(r.dest, "utf8")).toContain(`BURROW_LIB_DIR="${join(xdg, "burrow", "cli")}"`);
    expect(existsSync(join(xdg, "burrow", "cli", "src", "cli.ts"))).toBe(true);
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

  test("an old 0.7.3-style host (only ~/.local/bin/suite, lib at ~/.local/share/suite/cli) gets `burrow`; the old `suite` and lib are left untouched", () => {
    const home = makeHome();
    const lib = join(home, ".local", "share", "suite", "cli");
    mkdirSync(join(lib, "src"), { recursive: true });
    writeFileSync(join(lib, "package.json"), `{"name":"suite-cli","version":"${OLD_VERSION}"}\n`);
    writeFileSync(join(lib, "src", "cli.ts"), "// the 0.7.3 library\n");
    const old = join(home, ".local", "bin", "suite");
    // The shape of a rendered 0.7.3 launcher: SUITE_* names, --version in sh.
    const oldLauncher =
      `#!/bin/sh\nSUITE_LIB_DIR="${lib}"\nSUITE_VERSION="${OLD_VERSION}"\nexport SUITE_LIB_DIR SUITE_VERSION\n` +
      'case "${1:-}" in --version | -V) printf \'%s\\n\' "$SUITE_VERSION"; exit 0 ;; esac\n' +
      'exec bun "$SUITE_LIB_DIR/src/cli.ts" "$@"\n';
    writeFileSync(old, oldLauncher);
    chmodSync(old, 0o755);
    expect(existsSync(join(home, ".local", "bin", "burrow"))).toBe(false);

    // No `burrow` yet, so nothing to replace and nothing to ask.
    const r = runInstaller(home, { stdin: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("already installed");
    expect(spawnSync(r.dest, ["--version"], { encoding: "utf8" }).stdout).toBe(`${VERSION}\n`);
    // The old `suite` is not the installer's to remove: byte-identical.
    expect(readFileSync(old, "utf8")).toBe(oldLauncher);
    // The new library goes to burrow/cli. The old one is RETIRED, never moved
    // or deleted: a running watch daemon may still be executing from it.
    const newLib = join(home, ".local", "share", "burrow", "cli");
    expect(readFileSync(join(newLib, "src", "cli.ts"), "utf8")).not.toContain("the 0.7.3 library");
    expect(readFileSync(r.dest, "utf8")).toContain(`BURROW_LIB_DIR="${newLib}"`);
    expect(readFileSync(join(lib, "src", "cli.ts"), "utf8")).toBe("// the 0.7.3 library\n");
  });

  /* BURROW_* first, SUITE_* fallback, BURROW wins -------------------------- */

  const SHA_A = "0123456789abcdef0123456789abcdef01234567";
  const codeload = (owner: string, ref: string) =>
    `https://codeload.github.com/${owner}/burrow-cli/tar.gz/${/^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`}`;

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
    expect(existsSync(r.dest)).toBe(true);
  });
});

/*
 * TAGS AND THE REPO NAME, with a stub curl that logs every URL it is asked
 * for, in order, and answers like codeload: 200 (and the tarball) for a URL in
 * STUB_SERVE, else a 404 status and curl -f's exit 22. MEASURED 2026-10-18
 * against suite-cli: /tar.gz/v0.8.0 200, /tar.gz/refs/tags/v0.8.0 200,
 * /tar.gz/refs/heads/v0.8.0 404, and every burrow-cli URL 404 (the repo does
 * not exist under that name until the rename).
 */
describe("install.sh: refs and the repo name", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const at = (repo: string, path: string) => `https://codeload.github.com/Startup-Suite/${repo}/tar.gz/${path}`;

  /** Run the installer against the codeload stub; `serve` URLs answer 200 with `archive`. */
  function runCodeload(env: Record<string, string>, serve: string[] = [], archive: string = tarball) {
    const home = makeHome();
    const stubDir = join(home, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const log = join(home, "urls.log");
    writeFileSync(
      join(stubDir, "curl"),
      [
        "#!/bin/sh",
        'out=""; url=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '  -o) out="$2"; shift ;;',
        '  https://*) url="$1" ;;',
        "  esac",
        "  shift",
        "done",
        `printf '%s\\n' "$url" >>"${log}"`,
        'case " $STUB_SERVE " in',
        `*" $url "*) cp "$STUB_ARCHIVE" "$out"; printf 200; exit 0 ;;`,
        "esac",
        // A failure with no HTTP status at all (curl exit 6: no such host).
        'if [ -n "$STUB_EXIT" ]; then printf 000; exit "$STUB_EXIT"; fi',
        "printf 404",
        "exit 22",
        "",
      ].join("\n"),
    );
    chmodSync(join(stubDir, "curl"), 0o755);
    const r = runInstallSh({
      PATH: `${stubDir}:${ghlessPath()}`,
      HOME: home,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      STUB_SERVE: serve.join(" "),
      STUB_ARCHIVE: archive,
      ...env,
    });
    return {
      status: r.status ?? -1,
      stderr: r.stderr ?? "",
      urls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [],
      dest: join(home, ".local", "bin", "burrow"),
    };
  }

  test("v0.8.0 (a bare tag): the branch path first, then the tag path, and it installs", () => {
    // Today's world: burrow-cli 404s everywhere, suite-cli serves the tag.
    const r = runCodeload({ BURROW_CLI_REF: "v0.8.0" }, [at("suite-cli", "refs/tags/v0.8.0")]);
    expect(r.urls).toEqual([
      at("burrow-cli", "refs/heads/v0.8.0"),
      at("burrow-cli", "refs/tags/v0.8.0"),
      at("suite-cli", "refs/heads/v0.8.0"),
      at("suite-cli", "refs/tags/v0.8.0"),
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
  });

  test("after the rename: v0.8.0 is served by burrow-cli and suite-cli is never fetched", () => {
    const r = runCodeload({ BURROW_CLI_REF: "v0.8.0" }, [at("burrow-cli", "refs/tags/v0.8.0")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/heads/v0.8.0"), at("burrow-cli", "refs/tags/v0.8.0")]);
    expect(r.status).toBe(0);
  });

  test("refs/tags/v0.8.0: one URL per repo, verbatim", () => {
    const r = runCodeload({ BURROW_CLI_REF: "refs/tags/v0.8.0" }, [at("burrow-cli", "refs/tags/v0.8.0")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/tags/v0.8.0")]);
    expect(r.status).toBe(0);
  });

  test("a SHA: one URL, verbatim", () => {
    const r = runCodeload({ BURROW_CLI_REF: SHA }, [at("burrow-cli", SHA)]);
    expect(r.urls).toEqual([at("burrow-cli", SHA)]);
    expect(r.status).toBe(0);
  });

  test("main: the branch path, and a branch wins over a tag of the same name", () => {
    const r = runCodeload({}, [at("burrow-cli", "refs/heads/main"), at("burrow-cli", "refs/tags/main")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/heads/main")]);
    expect(r.status).toBe(0);
  });

  test("burrow-cli 404 falls back to suite-cli, in that order", () => {
    const r = runCodeload({}, [at("suite-cli", "refs/heads/main")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/heads/main"), at("burrow-cli", "refs/tags/main"), at("suite-cli", "refs/heads/main")]);
    expect(r.status).toBe(0);
  });

  test("burrow-cli 200 means suite-cli is never fetched", () => {
    const r = runCodeload({}, [at("burrow-cli", "refs/heads/main"), at("suite-cli", "refs/heads/main")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/heads/main")]);
    expect(r.urls.some((u) => u.includes("/suite-cli/"))).toBe(false);
  });

  test("a failure that is not a 404 stops at the first URL: never falls through to another ref or repo", () => {
    const r = runCodeload({ STUB_EXIT: "6" }, [at("suite-cli", "refs/heads/main")]);
    expect(r.urls).toEqual([at("burrow-cli", "refs/heads/main")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${at("burrow-cli", "refs/heads/main")} (000)`);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("nothing anywhere: the failure names EVERY URL tried, with its status", () => {
    const r = runCodeload({ BURROW_CLI_REF: "v9.9.9" });
    expect(r.status).not.toBe(0);
    expect(r.urls).toHaveLength(4);
    for (const url of r.urls) expect(r.stderr).toContain(`${url} (404)`);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("a burrow-cli-<sha> archive root installs (the renamed repo's tarball)", () => {
    const stage = mkdtempSync(join(workRoot, "renamed."));
    const root = join(stage, `burrow-cli-${SHA}`);
    mkdirSync(root, { recursive: true });
    for (const entry of ["install.sh", "package.json", "src", "bin", "assets"]) {
      expect(spawnSync("cp", ["-R", join(REPO_ROOT, entry), join(root, entry)]).status).toBe(0);
    }
    const archive = join(stage, "burrow-cli.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", stage, `burrow-cli-${SHA}`]).status).toBe(0);
    const r = runCodeload({ BURROW_CLI_REF: SHA }, [at("burrow-cli", SHA)], archive);
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
    expect(spawnSync(r.dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(VERSION);
  });

  test("BURROW_CLI_REPO names one repo, with no fallback", () => {
    const r = runCodeload({ BURROW_CLI_REPO: "my-fork" });
    expect(r.urls).toEqual([at("my-fork", "refs/heads/main"), at("my-fork", "refs/tags/main")]);
    expect(r.status).not.toBe(0);
  });

  for (const bad of ["../x", "a/b", "-x", ".x", "a b", "x;id"]) {
    test(`BURROW_CLI_REPO=${JSON.stringify(bad)} is refused by name BEFORE any fetch`, () => {
      const r = runCodeload({ BURROW_CLI_REPO: bad });
      expect(r.status).not.toBe(0);
      expect(r.urls).toEqual([]);
      expect(r.stderr).toContain("BURROW_CLI_REPO=");
    });
  }

  for (const bad of ["a b", "../x", "-x", "x;id"]) {
    test(`the ref ${JSON.stringify(bad)} is refused BEFORE any fetch`, () => {
      const r = runCodeload({ BURROW_CLI_REF: bad });
      expect(r.status).not.toBe(0);
      expect(r.urls).toEqual([]);
      expect(r.stderr).toContain("is not a plain branch, tag or commit");
    });
  }
});
