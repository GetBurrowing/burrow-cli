/**
 * The ONE source of repository identity.
 *
 * Every GitHub URL this CLI builds (its own installer and tarball, the commits
 * API it resolves refs against, the plugin and channel repos it clones, the
 * `Documentation=` line of the units it writes) is built here, from one owner.
 * A second copy of the owner is a second thing to keep true during an org
 * rename, and the copy that drifts is the one nobody runs.
 *
 * THE DEFAULT STAYS `Startup-Suite` until the rename is the last step left.
 * Old URLs keep working through GitHub's rename redirects; the override exists
 * so the new org can be exercised before it is the default. Flipping it is a
 * one-line change to {@link DEFAULT_GITHUB_OWNER} plus install.sh's default.
 *
 * THE OVERRIDE IS READ FROM THE PROCESS ENVIRONMENT ONLY. Never from a config
 * file: an agent or a channel can write those, and whatever names this owner
 * chooses what code a machine installs and runs.
 *
 * A malformed owner is REFUSED and named, never quoted-and-hoped. It reaches
 * URLs and an `sh -c` command line (see update.ts), and the narrow slug set
 * below has no character that means anything to either.
 */
import { burrowName, envSource, suiteName } from "./env_names.ts";

/** The GitHub org every repo lives under today. */
export const DEFAULT_GITHUB_OWNER = "Startup-Suite";

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
 * (`${SUITE_GITHUB_OWNER:-Startup-Suite}`) and the same one SUITE_CLI_REF
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
 * The tarball for `ref`, with install.sh's own rule: codeload serves a commit
 * SHA at `/tar.gz/<sha>` and a branch at `/tar.gz/refs/heads/<branch>`. A tag
 * is NOT a supported install ref; it would be read as a branch and 404.
 */
export function codeloadUrl(repo: string, ref: string, env: Env = process.env): string {
  const path = /^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`;
  return `https://codeload.github.com/${repoSlug(repo, env)}/tar.gz/${path}`;
}

export function apiCommitUrl(repo: string, ref: string, env: Env = process.env): string {
  return `https://api.github.com/repos/${repoSlug(repo, env)}/commits/${ref}`;
}
