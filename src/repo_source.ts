/**
 * The ONE source of repository identity.
 *
 * Every GitHub URL this CLI builds (its own installer and tarball, the commits
 * API it resolves refs against, the plugin and channel repos it clones, the
 * `Documentation=` line of the units it writes) is built here, from one owner.
 * A second copy of the owner is a second thing to keep true during an org
 * rename, and the copy that drifts is the one nobody runs.
 *
 * THE DEFAULT IS `GetBurrowing` (0.12.1 on). The org was renamed in place;
 * {@link DEFAULT_GITHUB_OWNER} and install.sh's default are the only two
 * places that name it. The override exists so a fork or a future org can be
 * exercised before it is the default.
 *
 * THE OVERRIDE IS READ FROM THE PROCESS ENVIRONMENT ONLY. Never from a config
 * file: an agent or a channel can write those, and whatever names this owner
 * chooses what code a machine installs and runs.
 *
 * A malformed owner is REFUSED and named, never quoted-and-hoped. It reaches
 * URLs and an `sh -c` command line (see update.ts), and the narrow slug set
 * below has no character that means anything to either.
 */
import { BURROW_PREFIX, burrowName, envSource, suiteName } from "./env_names.ts";

/** The GitHub org every repo lives under. */
export const DEFAULT_GITHUB_OWNER = "GetBurrowing";

/**
 * The legacy environment variable that overrides it, and the name this CLI
 * still hands to its installer. Reads go through env_names.ts, which prefers
 * {@link OWNER_ENV_BURROW} and falls back to this one.
 */
export const OWNER_ENV = suiteName("GITHUB_OWNER");

/** The Burrow-generation name for the same override. Wins when both are set. */
export const OWNER_ENV_BURROW = burrowName("GITHUB_OWNER");

/**
 * GitHub's own owner rule: 1-39 characters, alphanumeric or hyphen, not
 * starting with a hyphen. No `.` (so no `..`), no `/`, nothing a shell reads.
 */
const OWNER_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type Env = Record<string, string | undefined>;

export class InvalidGithubOwner extends Error {
  /** `variable` is the one that actually supplied the value, so the operator fixes the right one. */
  constructor(
    readonly value: string,
    readonly variable: string = OWNER_ENV,
  ) {
    super(
      `${variable}=${JSON.stringify(value)} is not a GitHub owner name (1-39 letters, digits or hyphens, not starting with a hyphen). Refusing to build a URL from it.`,
    );
    this.name = "InvalidGithubOwner";
  }
}

export function ownerIsValid(owner: string): boolean {
  return OWNER_SLUG.test(owner) && !owner.includes("..") && !owner.includes("/");
}

/**
 * The owner to use: `BURROW_GITHUB_OWNER`, else `SUITE_GITHUB_OWNER`, else
 * the default (precedence lives in env_names.ts).
 *
 * Unset and empty both mean the default, the same rule install.sh applies
 * (`${BURROW_GITHUB_OWNER:-${SUITE_GITHUB_OWNER:-GetBurrowing}}`) and the same one SUITE_CLI_REF
 * follows. Anything else must be a valid slug or this throws.
 */
export function ownerFrom(env: Env = process.env): string {
  const source = envSource(env, "GITHUB_OWNER");
  if (source === null || source.value === "") return DEFAULT_GITHUB_OWNER;
  if (!ownerIsValid(source.value)) throw new InvalidGithubOwner(source.value, source.name);
  return source.value;
}

/** `<owner>/<repo>`. */
export function repoSlug(repo: string, env: Env = process.env): string {
  return `${ownerFrom(env)}/${repo}`;
}

/** The repo's web page, e.g. for a unit's `Documentation=` line. */
export function webUrl(repo: string, env: Env = process.env): string {
  return `https://github.com/${repoSlug(repo, env)}`;
}

export function httpsCloneUrl(repo: string, env: Env = process.env): string {
  return `https://github.com/${repoSlug(repo, env)}.git`;
}

export function sshCloneUrl(repo: string, env: Env = process.env): string {
  return `git@github.com:${repoSlug(repo, env)}.git`;
}

export function rawUrl(repo: string, ref: string, path: string, env: Env = process.env): string {
  return `https://raw.githubusercontent.com/${repoSlug(repo, env)}/${ref}/${path}`;
}

/**
 * The codeload paths to try for `ref`, in order, with install.sh's own rule.
 *
 * MEASURED 2026-10-18 against the pre-rename repo: `/tar.gz/v0.8.0` 200,
 * `/tar.gz/refs/tags/v0.8.0` 200, `/tar.gz/refs/heads/v0.8.0` 404. So:
 *   - a 40-hex SHA, or a full `refs/heads/*` / `refs/tags/*` ref: verbatim, one path;
 *   - a bare name: `refs/heads/<name>`, then `refs/tags/<name>` on a 404. A
 *     branch still wins over a tag of the same name, as it did before tags
 *     were accepted at all.
 */
export function codeloadRefPaths(ref: string): string[] {
  if (/^[0-9a-f]{40}$/.test(ref) || ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`];
}

/** The FIRST tarball URL for `ref` (see {@link codeloadRefPaths} for the rest). */
export function codeloadUrl(repo: string, ref: string, env: Env = process.env): string {
  return `https://codeload.github.com/${repoSlug(repo, env)}/tar.gz/${codeloadRefPaths(ref)[0]}`;
}

/* ------------------------------------------------------------------------- */
/* This CLI's own repo name                                                   */
/* ------------------------------------------------------------------------- */

/**
 * This CLI's repo, and the name it had before 0.9.0.
 *
 * THE CODE WORKS UNDER BOTH until the rename happens, and after it. Measured
 * 2026-10-18: github.com/Startup-Suite/burrow-cli 404s and the legacy name is
 * public. After `gh repo rename` GitHub redirects the legacy name to
 * burrow-cli, but nothing here relies on that redirect: every fetch of this
 * CLI's own files tries {@link CLI_REPO_NAME} first and falls back to
 * {@link LEGACY_CLI_REPO_NAME} on a 404 only, so before the rename burrow-cli
 * 404s and the legacy name answers, and after it burrow-cli answers and the
 * legacy name is never asked.
 *
 * Measured 2026-10-20, after both renames: github.com/GetBurrowing/burrow-cli
 * answers, so the legacy name is never asked under the default owner. The
 * fallback stays for a pinned older ref and for an override naming an org
 * where only the legacy name exists. Under the old org, the new repo name
 * 404s, because GitHub's redirect follows the name each repo had when the
 * org moved (the legacy name redirects to GetBurrowing/burrow-cli; the new
 * name under the old org never existed). That is why 0.12.0 and earlier
 * reached burrow-cli only through this fallback.
 */
export const CLI_REPO_NAME = "burrow-cli";
export const LEGACY_CLI_REPO_NAME = "suite-cli";

/**
 * Names ONE repo to fetch this CLI from, with no fallback. Burrow-only: the
 * variable is new in 0.9.0, so there is no SUITE_* twin to honour. Read from
 * the process environment only, for the reason the owner override is.
 */
export const CLI_REPO_ENV = `${BURROW_PREFIX}CLI_REPO`;

/**
 * GitHub's repo-name characters: letters, digits, `-`, `_` and `.`, at most
 * 100. Not starting with `.` or `-`, and no `..`, so it cannot climb out of
 * the URL path it is pasted into or read as a flag.
 */
const REPO_SLUG = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,99})$/;

export function repoNameIsValid(repo: string): boolean {
  return REPO_SLUG.test(repo) && !repo.includes("..");
}

export class InvalidRepoName extends Error {
  constructor(readonly value: string) {
    super(
      `${CLI_REPO_ENV}=${JSON.stringify(value)} is not a GitHub repository name (letters, digits, '-', '_' or '.', not starting with '-' or '.'). Refusing to build a URL from it.`,
    );
    this.name = "InvalidRepoName";
  }
}

/**
 * The repos to fetch this CLI from, in order: `[BURROW_CLI_REPO]` when it is
 * set, else `[CLI_REPO_NAME, LEGACY_CLI_REPO_NAME]`. Unset and empty both mean the default
 * pair. An invalid override throws, before any URL exists.
 */
export function cliRepoNames(env: Env = process.env): string[] {
  const value = env[CLI_REPO_ENV];
  if (value === undefined || value === "") return [CLI_REPO_NAME, LEGACY_CLI_REPO_NAME];
  if (!repoNameIsValid(value)) throw new InvalidRepoName(value);
  return [value];
}

export function apiCommitUrl(repo: string, ref: string, env: Env = process.env): string {
  return `https://api.github.com/repos/${repoSlug(repo, env)}/commits/${ref}`;
}
