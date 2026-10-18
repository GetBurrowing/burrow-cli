/**
 * Repository identity: one owner, from one place.
 *
 * Three things are pinned here:
 *   1. src/repo_source.ts resolves the owner (default, override, refusal).
 *   2. A repo-wide guard: no `Startup-Suite` literal in src/ or install.sh
 *      outside repo_source.ts and install.sh's one default line. Its positive
 *      control runs the same scanner over a synthetic file, so the guard is
 *      shown able to fire on every run, not only the once it was written.
 *   3. Every call site, under SUITE_GITHUB_OWNER=GetBurrowing, builds a
 *      GetBurrowing URL. The update path is asserted on BOTH halves: the URL
 *      it downloads the installer from AND the owner it exports to that
 *      installer, so the two cannot come from different orgs.
 *
 * All fixture values are invented. GetBurrowing is the planned new org name;
 * nothing here fetches from it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  DEFAULT_GITHUB_OWNER,
  InvalidGithubOwner,
  OWNER_ENV,
  OWNER_ENV_BURROW,
  CLI_REPO_ENV,
  CLI_REPO_NAME,
  InvalidRepoName,
  LEGACY_CLI_REPO_NAME,
  apiCommitUrl,
  cliRepoNames,
  codeloadRefPaths,
  codeloadUrl,
  repoNameIsValid,
  httpsCloneUrl,
  ownerFrom,
  ownerIsValid,
  rawUrl,
  repoSlug,
  sshCloneUrl,
  webUrl,
} from "../src/repo_source.ts";
import { installerUrl, runUpdate, updateArgv, UPDATE_REFUSED_EXIT, type UpdateDeps } from "../src/commands/update.ts";
import { PLUGIN_REPO_NAME, pluginRepo, pullRemedyLines } from "../src/commands/init.ts";
import { ensurePluginAtPin } from "../src/claude_wiring.ts";
import { OPENCLAW_CHANNEL_REPO_NAME, openclawChannelRepo } from "../src/commands/openclaw.ts";
import { HERMES_CHANNEL_REPO_NAME, hermesChannelRepo } from "../src/commands/hermes.ts";
import { restoreUnit, systemdUnit } from "../src/supervisor.ts";

const NEW = { [OWNER_ENV]: "GetBurrowing" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("ownerFrom", () => {
  test("unset means the default, which is still Startup-Suite", () => {
    // The flip is a later patch release at cutover; see the CHANGELOG.
    expect(DEFAULT_GITHUB_OWNER).toBe("Startup-Suite");
    expect(ownerFrom({})).toBe("Startup-Suite");
  });

  test("empty means the default too, the same rule install.sh's ${VAR:-default} applies", () => {
    expect(ownerFrom({ [OWNER_ENV]: "" })).toBe("Startup-Suite");
  });

  test("the override is honoured", () => {
    expect(ownerFrom(NEW)).toBe("GetBurrowing");
    expect(repoSlug("suite-cli", NEW)).toBe("GetBurrowing/suite-cli");
  });

  test("a 39-character owner, the longest GitHub allows, is accepted", () => {
    const owner = "a".repeat(39);
    expect(ownerFrom({ [OWNER_ENV]: owner })).toBe(owner);
  });

  for (const bad of ["../x", "a/b", "", "a".repeat(40), "-x", "a b", "a.b", "x;rm", "x'y", "é"]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(ownerIsValid(bad)).toBe(false);
      if (bad === "") return; // empty is the default, not an owner; see above
      expect(() => ownerFrom({ [OWNER_ENV]: bad })).toThrow(InvalidGithubOwner);
    });
  }

  test("the refusal names the variable", () => {
    expect(() => ownerFrom({ [OWNER_ENV]: "../x" })).toThrow(OWNER_ENV);
  });

  test("BURROW_GITHUB_OWNER is honoured, and wins over SUITE_GITHUB_OWNER", () => {
    expect(OWNER_ENV_BURROW).toBe("BURROW_GITHUB_OWNER");
    expect(ownerFrom({ [OWNER_ENV_BURROW]: "GetBurrowing" })).toBe("GetBurrowing");
    expect(ownerFrom({ [OWNER_ENV_BURROW]: "GetBurrowing", [OWNER_ENV]: "Startup-Suite" })).toBe("GetBurrowing");
  });

  test("an empty BURROW_GITHUB_OWNER falls back to SUITE_GITHUB_OWNER", () => {
    expect(ownerFrom({ [OWNER_ENV_BURROW]: "", [OWNER_ENV]: "GetBurrowing" })).toBe("GetBurrowing");
  });

  test("the refusal names the variable that SUPPLIED the bad value, not a fixed one", () => {
    const fromBurrow = (() => {
      try {
        ownerFrom({ [OWNER_ENV_BURROW]: "../x", [OWNER_ENV]: "Startup-Suite" });
      } catch (e) {
        return e as InvalidGithubOwner;
      }
    })();
    expect(fromBurrow).toBeInstanceOf(InvalidGithubOwner);
    expect(fromBurrow?.variable).toBe("BURROW_GITHUB_OWNER");
    expect(fromBurrow?.message.startsWith('BURROW_GITHUB_OWNER="../x"')).toBe(true);
    expect(() => ownerFrom({ [OWNER_ENV]: "../x" })).toThrow('SUITE_GITHUB_OWNER="../x"');
  });
});

describe("URL helpers", () => {
  test("each helper builds from the resolved owner", () => {
    expect(webUrl("r", NEW)).toBe("https://github.com/GetBurrowing/r");
    expect(httpsCloneUrl("r", NEW)).toBe("https://github.com/GetBurrowing/r.git");
    expect(sshCloneUrl("r", NEW)).toBe("git@github.com:GetBurrowing/r.git");
    expect(rawUrl("r", "main", "install.sh", NEW)).toBe("https://raw.githubusercontent.com/GetBurrowing/r/main/install.sh");
    expect(apiCommitUrl("r", "main", NEW)).toBe("https://api.github.com/repos/GetBurrowing/r/commits/main");
  });

  test("codeload follows install.sh's SHA / full-ref / bare-name rule", () => {
    expect(codeloadUrl("r", SHA, NEW)).toBe(`https://codeload.github.com/GetBurrowing/r/tar.gz/${SHA}`);
    expect(codeloadUrl("r", "main", NEW)).toBe("https://codeload.github.com/GetBurrowing/r/tar.gz/refs/heads/main");
    expect(codeloadRefPaths(SHA)).toEqual([SHA]);
    expect(codeloadRefPaths("refs/tags/v0.8.0")).toEqual(["refs/tags/v0.8.0"]);
    expect(codeloadRefPaths("refs/heads/next")).toEqual(["refs/heads/next"]);
    // A bare name: the branch first (precedence unchanged), the tag on a 404.
    expect(codeloadRefPaths("v0.8.0")).toEqual(["refs/heads/v0.8.0", "refs/tags/v0.8.0"]);
  });

  test("this CLI's repo: burrow-cli, then suite-cli; BURROW_CLI_REPO names exactly one", () => {
    expect(CLI_REPO_NAME).toBe("burrow-cli");
    expect(LEGACY_CLI_REPO_NAME).toBe("suite-cli");
    expect(CLI_REPO_ENV).toBe("BURROW_CLI_REPO");
    expect(cliRepoNames({})).toEqual(["burrow-cli", "suite-cli"]);
    expect(cliRepoNames({ BURROW_CLI_REPO: "" })).toEqual(["burrow-cli", "suite-cli"]);
    expect(cliRepoNames({ BURROW_CLI_REPO: "my-fork.cli_2" })).toEqual(["my-fork.cli_2"]);
  });

  for (const bad of ["../x", "a/b", "-x", ".x", "a..b", "a b", "x;id", "x'y", "a".repeat(101)]) {
    test(`BURROW_CLI_REPO=${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 8)}...` : bad)} is refused by name`, () => {
      expect(repoNameIsValid(bad)).toBe(false);
      expect(() => cliRepoNames({ BURROW_CLI_REPO: bad })).toThrow(InvalidRepoName);
      expect(() => cliRepoNames({ BURROW_CLI_REPO: bad })).toThrow("BURROW_CLI_REPO=");
    });
  }
});

/* ------------------------------------------------------------------------- */
/* The guard                                                                  */
/* ------------------------------------------------------------------------- */

const ROOT = resolve(import.meta.dir, "..");
const LITERAL = "Startup-Suite";
/** The one line in install.sh allowed to name the org: its default. */
const INSTALL_DEFAULT_LINE = 'OWNER="Startup-Suite"';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Every `file:line` under `root` naming the org outside the allowed places.
 * Walks the filesystem, not `git ls-files`, so a new untracked file is
 * scanned too.
 */
function orgLiteralViolations(root: string): string[] {
  const files = [...walk(join(root, "src")), join(root, "install.sh")];
  const hits: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (rel === join("src", "repo_source.ts")) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.includes(LITERAL)) return;
        if (rel === "install.sh" && line.trim() === INSTALL_DEFAULT_LINE) return;
        hits.push(`${rel}:${i + 1}`);
      });
  }
  return hits;
}

describe("guard: one source of repository identity", () => {
  test("no Startup-Suite literal in src/ or install.sh outside repo_source.ts and the installer default", () => {
    expect(orgLiteralViolations(ROOT)).toEqual([]);
  });

  test("the scan is not vacuous: it reads src/ and finds the installer's default line", () => {
    expect(walk(join(ROOT, "src")).length).toBeGreaterThan(10);
    const defaults = readFileSync(join(ROOT, "install.sh"), "utf8")
      .split("\n")
      .filter((l) => l.trim() === INSTALL_DEFAULT_LINE);
    expect(defaults.length).toBe(1);
    expect(readFileSync(join(ROOT, "src", "repo_source.ts"), "utf8")).toContain(`"${LITERAL}"`);
  });

  test("POSITIVE CONTROL: the scanner fires on a planted literal", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "suite-cli-guard."));
    try {
      await Bun.write(join(scratch, "src", "x.ts"), `export const U = "https://github.com/${LITERAL}/x.git";\n`);
      await Bun.write(join(scratch, "src", "repo_source.ts"), `export const D = "${LITERAL}";\n`);
      await Bun.write(join(scratch, "install.sh"), `${INSTALL_DEFAULT_LINE}\nREPO="${LITERAL}/suite-cli"\n`);
      expect(orgLiteralViolations(scratch)).toEqual([join("src", "x.ts") + ":1", "install.sh:2"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Every call site, under the override                                        */
/* ------------------------------------------------------------------------- */

function updateDeps(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const deps: UpdateDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    which: (name) => `/usr/bin/${name}`,
    exec: async (argv) => {
      ran.push(argv);
      return 0;
    },
    // A SHA ref: resolveRefToSha returns it unchanged, so nothing touches the network.
    env: { SUITE_CLI_REF: SHA, ...env },
  };
  return { deps, out, err, ran };
}

describe("update.ts: the owner reaches BOTH halves", () => {
  test("installerUrl names the owner", () => {
    expect(installerUrl("main", NEW)).toBe("https://raw.githubusercontent.com/GetBurrowing/burrow-cli/main/install.sh");
  });

  for (const fetcher of ["curl", "wget"] as const) {
    test(`updateArgv (${fetcher}): the URL and the exported env carry the SAME owner`, () => {
      const script = updateArgv(SHA, fetcher, NEW)[2] ?? "";
      expect(script).toContain(`https://raw.githubusercontent.com/GetBurrowing/burrow-cli/${SHA}/install.sh`);
      expect(script).toContain(`https://raw.githubusercontent.com/GetBurrowing/suite-cli/${SHA}/install.sh`);
      expect(script).toContain(`${OWNER_ENV}='GetBurrowing' SUITE_CLI_REF='${SHA}' sh `);
      expect(script).not.toContain(DEFAULT_GITHUB_OWNER);
    });
  }

  test("a BURROW_GITHUB_OWNER reaches the installer under the name install.sh reads today", () => {
    const script = updateArgv(SHA, "curl", { [OWNER_ENV_BURROW]: "GetBurrowing" })[2] ?? "";
    expect(script).toContain(`https://raw.githubusercontent.com/GetBurrowing/burrow-cli/${SHA}/install.sh`);
    expect(script).toContain(`${OWNER_ENV}='GetBurrowing' SUITE_CLI_REF='${SHA}' sh `);
  });

  test("default: both halves say Startup-Suite", () => {
    const script = updateArgv(SHA, "curl", {})[2] ?? "";
    expect(script).toContain("raw.githubusercontent.com/Startup-Suite/burrow-cli/");
    expect(script).toContain("raw.githubusercontent.com/Startup-Suite/suite-cli/");
    expect(script).toContain(`${OWNER_ENV}='Startup-Suite'`);
  });

  test("runUpdate takes the owner from its deps env and prints owner/repo", async () => {
    const d = updateDeps(NEW);
    expect(await runUpdate(d.deps)).toBe(0);
    expect(d.out).toContain("repository GetBurrowing/burrow-cli, else GetBurrowing/suite-cli");
    const script = d.ran[0]?.[2] ?? "";
    expect(script).toContain("raw.githubusercontent.com/GetBurrowing/burrow-cli/");
    expect(script).toContain(`${OWNER_ENV}='GetBurrowing'`);
  });

  test("runUpdate prints owner/repo on the default path too", async () => {
    const d = updateDeps({});
    expect(await runUpdate(d.deps)).toBe(0);
    expect(d.out).toContain("repository Startup-Suite/burrow-cli, else Startup-Suite/suite-cli");
  });

  test("an invalid owner is refused before anything runs or is announced", async () => {
    const d = updateDeps({ [OWNER_ENV]: "../x" });
    expect(await runUpdate(d.deps)).toBe(UPDATE_REFUSED_EXIT);
    expect(d.ran).toEqual([]);
    expect(d.out).toEqual([]);
    expect(d.err.join("\n")).toContain(OWNER_ENV);
  });
});

describe("init.ts", () => {
  test("the plugin clone argv uses the override", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "suite-cli-clone."));
    const ran: string[][] = [];
    try {
      await ensurePluginAtPin(
        {
          env: NEW,
          isTTY: false,
          out: () => {},
          run: async (argv) => {
            ran.push(argv);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        join(scratch, "plugin"),
        SHA,
        () => ({ args: [], cwds: [] }),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(ran[0]?.slice(0, 3)).toEqual(["git", "clone", "https://github.com/GetBurrowing/burrow-channel-claude-code.git"]);
    expect(pluginRepo(NEW)).toBe("https://github.com/GetBurrowing/burrow-channel-claude-code.git");
  });

  test("the SSH recovery hint uses the override", () => {
    expect(pullRemedyLines("auth", "/co", PLUGIN_REPO_NAME, NEW).join("\n")).toContain(
      "git -C /co remote set-url origin git@github.com:GetBurrowing/burrow-channel-claude-code.git",
    );
  });

  test("the SSH hint names the checkout's OWN repo, not the Claude plugin's", () => {
    const hint = pullRemedyLines("auth", "/co", OPENCLAW_CHANNEL_REPO_NAME, NEW).join("\n");
    expect(hint).toContain("git@github.com:GetBurrowing/burrow-channel-openclaw.git");
    expect(hint).not.toContain(PLUGIN_REPO_NAME);
  });
});

describe("openclaw.ts and hermes.ts", () => {
  test("the channel repos use the override", () => {
    expect(openclawChannelRepo(NEW)).toBe("https://github.com/GetBurrowing/burrow-channel-openclaw.git");
    expect(hermesChannelRepo(NEW)).toBe("https://github.com/GetBurrowing/burrow-channel-hermes.git");
    expect(HERMES_CHANNEL_REPO_NAME).toBe("burrow-channel-hermes");
    expect(OPENCLAW_CHANNEL_REPO_NAME).toBe("burrow-channel-openclaw");
    expect(PLUGIN_REPO_NAME).toBe("burrow-channel-claude-code");
  });
});

describe("supervisor.ts", () => {
  const base = { platform: "linux" as const, home: "/home/q", binary: "/home/q/.local/bin/suite", intervalSeconds: 60 };

  test("both units' Documentation= lines use the override", () => {
    expect(systemdUnit({ ...base, env: NEW })).toContain("Documentation=https://github.com/GetBurrowing/burrow-cli\n");
    expect(restoreUnit({ ...base, env: NEW })).toContain("Documentation=https://github.com/GetBurrowing/burrow-cli\n");
  });

  test("and the default without one", () => {
    expect(systemdUnit({ ...base, env: {} })).toContain("Documentation=https://github.com/Startup-Suite/burrow-cli\n");
  });
});
