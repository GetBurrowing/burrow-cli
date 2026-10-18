/**
 * `suite update` — replace this install with the latest published CLI.
 *
 * ONE INSTALL PATH, NOT TWO. Update re-runs `install.sh`, the same script the
 * cold-start `curl … | sh` runs. It does not fetch a tarball, stage a lib dir
 * or render the launcher itself. A second install mechanism is a second thing
 * to keep true — and the half that drifts is always the one nobody runs on a
 * fresh machine. Everything install.sh already guarantees (staged then moved
 * into place, never a partial file at the destination, no sudo, the previous
 * version named before it is replaced) is inherited rather than reimplemented.
 *
 * THE REF IS PASSED, NOT ASSUMED. `install.sh` resolves what to install from
 * `SUITE_CLI_REF`, which DEFAULTS TO `main` — it does not infer anything from
 * the URL it was itself downloaded from. So fetching the installer from a tag
 * and failing to export the ref installs `main` while appearing to honour the
 * tag: a wrong result that looks exactly like a right one. Both halves are set
 * from the same value here, deliberately, and {@link updateArgv} is exported so
 * that pairing can be asserted directly.
 *
 * THE OWNER IS PASSED, NOT ASSUMED, for the same reason. `install.sh` resolves
 * the org it downloads the tarball from out of `SUITE_GITHUB_OWNER`, which
 * defaults to the published org; it does not infer it from the installer URL.
 * So the owner that builds the installer URL here is the SAME value exported
 * into the installer's environment, and the installer and the tarball cannot
 * come from two orgs. The resolved `owner/repo` is printed on every update.
 */
import { VERSION, CLI_NAME } from "../version.ts";
import { burrowName, envSource, suiteName } from "../env_names.ts";
import {
  CLI_REPO_ENV,
  CLI_REPO_NAME,
  LEGACY_CLI_REPO_NAME,
  OWNER_ENV_BURROW,
  apiCommitUrl,
  cliRepoNames,
  ownerFrom,
  rawUrl,
  repoSlug,
  type Env,
} from "../repo_source.ts";

/** This CLI's repo name. Its owner comes from repo_source.ts. */
export const REPO_NAME = CLI_REPO_NAME;
/**
 * Its name before 0.9.0. Every fetch tries {@link REPO_NAME} first and this on
 * a 404, so update works before and after `gh repo rename` without relying on
 * GitHub's redirect (see repo_source.ts).
 */
export const LEGACY_REPO_NAME = LEGACY_CLI_REPO_NAME;

/**
 * The env that pins a single, already-resolved owner. Keyed by the BURROW name
 * so re-reading it through env_names.ts is not mistaken for an operator still
 * setting the legacy variable.
 */
function ownerEnv(owner: string): Env {
  return { [OWNER_ENV_BURROW]: owner };
}

/** What `install.sh` itself defaults to when SUITE_CLI_REF is unset. */
export const DEFAULT_REF = "main";

/** Exit code when we refuse to run: preconditions missing, or a bad ref. */
export const UPDATE_REFUSED_EXIT = 5;

/**
 * The installer needs one of these to fetch, and `tar` to unpack. Named here
 * so a missing tool is reported as the missing tool, rather than as whatever
 * obscure noise a broken pipe makes three commands later.
 */
export const FETCHERS = ["curl", "wget"] as const;
export type Fetcher = (typeof FETCHERS)[number];
export const REQUIRED_TOOLS = ["tar", "sh"] as const;

/**
 * Refs we are willing to interpolate into a shell command: a branch, a bare
 * tag (`v0.8.0`), a full `refs/heads/<b>` or `refs/tags/<t>`, or a commit SHA.
 * raw.githubusercontent.com serves the installer at both `<tag>` and
 * `refs/tags/<tag>` (measured 200, 2026-10-18), and install.sh resolves either.
 *
 * The ref reaches `sh -c`, so it is the one attacker-shaped input on this path.
 * Git's own rules are wider than this; the narrow set is the point. A ref
 * outside it is REFUSED and named, never quoted-and-hoped — quoting is a thing
 * you get subtly wrong once and never notice.
 */
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function refIsSafe(ref: string): boolean {
  // `..` would let a ref climb out of the URL path it is pasted into.
  return ref.length > 0 && ref.length <= 200 && SAFE_REF.test(ref) && !ref.includes("..");
}

/** Where the installer for `ref` lives in `repo` (default {@link REPO_NAME}), under the owner `env` names. */
export function installerUrl(ref: string, env: Env = process.env, repo: string = REPO_NAME): string {
  return rawUrl(repo, ref, "install.sh", env);
}

/** Every installer URL to try, in order: one per repo from {@link cliRepoNames}. */
export function installerUrls(ref: string, env: Env = process.env): string[] {
  return cliRepoNames(env).map((repo) => installerUrl(ref, env, repo));
}

/**
 * Resolve a ref to a commit SHA, avoiding raw.githubusercontent.com's
 * branch-name cache. Returns the original ref if resolution fails.
 */
export async function resolveRefToSha(
  ref: string,
  env: Env = process.env,
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<Response> = fetch,
): Promise<string> {
  // Only resolve branch names; tags and SHAs are already immutable.
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  try {
    const token = process.env.GH_TOKEN ?? (await (async () => {
      const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      return text.trim() || undefined;
    })());
    const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
    if (token) headers.Authorization = `token ${token}`;
    // burrow-cli first, suite-cli on a 404 only (see repo_source.ts).
    for (const repo of cliRepoNames(env)) {
      const res = await fetchImpl(apiCommitUrl(repo, ref, env), { headers });
      if (res.status === 404) continue;
      if (!res.ok) return ref;
      // `res.json()` is `unknown` under this tsconfig, so the shape is narrowed
      // rather than asserted: a response without a string `sha` falls back to
      // the ref we already have instead of installing from `undefined`.
      const data: unknown = await res.json();
      const sha = typeof data === "object" && data !== null ? (data as { sha?: unknown }).sha : undefined;
      return typeof sha === "string" && sha !== "" ? sha : ref;
    }
    return ref;
  } catch {
    return ref;
  }
}

/**
 * `NAME='value'` assignments for the installer's environment, under BOTH the
 * BURROW_* and SUITE_* names, one value per pair.
 *
 * BOTH, because the installer that runs may be OLD: `burrow update` to a ref
 * pinned before the rename fetches an install.sh that reads only SUITE_*. A
 * BURROW-only export would silently install `main` from the default org while
 * looking like it honoured the pin. The new install.sh reads BURROW first, so
 * the pair can never disagree. Values are already validated as bare slugs and
 * safe refs, so they are safe inside single quotes.
 */
export function installerEnvAssignments(owner: string, ref: string): string {
  // BURROW names first, then SUITE: the order is cosmetic to sh, and keeps the
  // legacy pair adjacent exactly as a pre-rename `suite update` wrote it.
  return [
    `${burrowName("GITHUB_OWNER")}='${owner}'`,
    `${burrowName("CLI_REF")}='${ref}'`,
    `${suiteName("GITHUB_OWNER")}='${owner}'`,
    `${suiteName("CLI_REF")}='${ref}'`,
  ].join(" ");
}

/**
 * The exact argv that performs the update.
 *
 * The ref is exported into the installer's environment AND used to build its
 * URL, from the same argument — see the module note. Pure and exported so a
 * test can pin both halves without running an install.
 *
 * The owner is exported the same way: resolved ONCE from `env`, then used for
 * the installer URL and handed to the installer, which builds its tarball URL
 * from it. An invalid owner throws here, before any argv exists. Both go out
 * under both generations of name; see {@link installerEnvAssignments}.
 *
 * When the repo is private the raw URL 404s without auth, so we resolve a
 * GitHub token from `gh` and pass it as an Authorization header. The token
 * is resolved lazily at exec time, not baked into the argv, so no secret
 * appears in the printed command line.
 */
export function updateArgv(ref: string, fetcher: Fetcher = "curl", env: Env = process.env): string[] {
  // ownerFrom has validated this as a bare GitHub slug, so it is safe inside
  // single quotes in the sh -c line below.
  const owner = ownerFrom(env);
  const repos = cliRepoNames(env);
  const pinned = { ...ownerEnv(owner), [CLI_REPO_ENV]: env[CLI_REPO_ENV] };
  const urls = installerUrls(ref, pinned);

  // GH_TOKEN is exported so install.sh can use it for its own tarball fetch.
  // The ${TOKEN:+...} expansion emits the header only when a token was
  // resolved, keeping the public-repo path identical to today.
  //
  // The installer is downloaded to a temp file first, not piped directly to sh.
  // When curl -f writes to a pipe and the downstream process exits early
  // (e.g. install.sh's replace prompt is declined), curl fails with exit 23
  // ("Failure writing output to destination"), which -f promotes to a fatal
  // error even though the download itself succeeded.
  //
  // `$$` is the pid of the `sh -c` running this line, so two concurrent
  // updates (or two users on one box) never share a temp file. It is removed
  // afterwards and the installer's own exit code is kept.
  //
  // THE REPO FALLS BACK ON A 404 ONLY. Each URL after the first is tried only
  // when the one before it answered 404 (curl: `%{http_code}`; wget, which has
  // no such report, exit 8 "server issued an error response"). Any other
  // failure stops here with that fetch's exit code, so a network error never
  // quietly installs from a different repo.
  const tmp = "/tmp/burrow-install.sh.$$";
  // An override (validated by cliRepoNames) is handed on, so the installer fetches its tarball from the same repo.
  const override = env[CLI_REPO_ENV] ? `${CLI_REPO_ENV}='${repos[0]}' ` : "";
  const installer = `${override}${installerEnvAssignments(owner, ref)} sh ${tmp}; rc=$?; rm -f ${tmp}; exit $rc`;
  const one = (url: string): string =>
    fetcher === "curl"
      ? `code=$(curl -fsSL \${GH_TOKEN:+-H "Authorization: token $GH_TOKEN"} -w '%{http_code}' -o ${tmp} '${url}'); rc=$?`
      : `wget -q \${GH_TOKEN:+--header="Authorization: token $GH_TOKEN"} -O ${tmp} '${url}'; rc=$?; code=$([ $rc -eq 8 ] && echo 404)`;
  const steps = [one(urls[0] as string)];
  for (const url of urls.slice(1)) steps.push(`if [ $rc -ne 0 ] && [ "$code" = 404 ]; then ${one(url)}; fi`);
  const download = [
    "GH_TOKEN=$(gh auth token 2>/dev/null || true); export GH_TOKEN",
    ...steps,
    `if [ $rc -ne 0 ]; then rm -f ${tmp}; exit $rc; fi`,
    installer,
  ].join("; ");
  return ["sh", "-c", download];
}

/** The ref to install: explicit override (BURROW_CLI_REF, else SUITE_CLI_REF), else the published default. */
export function resolveRef(env: Record<string, string | undefined>): string {
  return resolveRefSource(env).value;
}

/** The ref plus the variable that supplied it, so a refusal names the one the operator set. */
export function resolveRefSource(env: Record<string, string | undefined>): { name: string | null; value: string } {
  const source = envSource(env, "CLI_REF");
  if (source === null || source.value === "") return { name: null, value: DEFAULT_REF };
  return source;
}

export interface UpdateDeps {
  out(line: string): void;
  err(line: string): void;
  /** Absolute path of a tool on PATH, or null. */
  which(name: string): string | null;
  /** Runs argv attached to the caller's terminal; resolves with its exit code. */
  exec(argv: string[]): Promise<number>;
  env: Record<string, string | undefined>;
}

/**
 * The lines printed before anything runs.
 *
 * NOTHING SILENT, the same rule `suite claude` carries: a command that is about
 * to fetch a remote script and pipe it into a shell says so, and names the URL,
 * BEFORE it does it. A non-default ref is called out too — updating to a branch
 * and not being told is how you end up debugging the wrong build.
 */
export function announceLines(ref: string, env: Env = process.env): string[] {
  const suffix = ref === DEFAULT_REF ? "" : ` (ref ${ref})`;
  const urls = installerUrls(ref, env);
  const repos = cliRepoNames(env);
  return [
    `updating ${CLI_NAME} ${VERSION}${suffix} — running the installer from ${urls[0]}`,
    ...(urls.length > 1 ? [`  (or, if that 404s, ${urls.slice(1).join(", then ")})`] : []),
    `repository ${repos.map((repo) => repoSlug(repo, env)).join(", else ")}`,
    "",
  ];
}

export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const refSource = resolveRefSource(deps.env);
  const ref = refSource.value;

  if (!refIsSafe(ref)) {
    deps.err(`${CLI_NAME}: refusing to update from ${refSource.name ?? "BURROW_CLI_REF"}="${ref}" — not a plain branch, tag or commit.`);
    return UPDATE_REFUSED_EXIT;
  }

  // The owner is resolved ONCE and every later step is handed that value, so
  // the API lookup, the installer URL and the installer's own tarball fetch
  // cannot disagree about which org they are talking to.
  let owner: string;
  try {
    owner = ownerFrom(deps.env);
    cliRepoNames(deps.env);
  } catch (e) {
    deps.err(`${CLI_NAME}: refusing to update: ${(e as Error).message}`);
    return UPDATE_REFUSED_EXIT;
  }
  const env = { ...ownerEnv(owner), [CLI_REPO_ENV]: deps.env[CLI_REPO_ENV] };

  // Preconditions BEFORE the announcement: telling somebody what you are about
  // to do and then not doing it is worse than refusing up front.
  const fetcher = FETCHERS.find((tool) => deps.which(tool) !== null);
  if (fetcher === undefined) {
    deps.err(`${CLI_NAME}: update needs ${FETCHERS.join(" or ")} to download the installer, and neither is on PATH.`);
    return UPDATE_REFUSED_EXIT;
  }
  const missing = REQUIRED_TOOLS.filter((tool) => deps.which(tool) === null);
  if (missing.length > 0) {
    deps.err(`${CLI_NAME}: update needs ${missing.join(" and ")}, not on PATH.`);
    return UPDATE_REFUSED_EXIT;
  }

  // Resolve branch names to commit SHAs to avoid raw.githubusercontent.com's
  // branch-name cache serving a stale install.sh.
  const sha = await resolveRefToSha(ref, env);
  if (sha !== ref) {
    deps.out(`resolved ${ref} to ${sha.slice(0, 7)}`);
  }

  for (const line of announceLines(ref, env)) deps.out(line);

  // The installer owns the outcome from here, including its own "replace
  // 0.1.0 with 0.2.0? [y/N]" prompt. It is NOT auto-answered: an update that
  // silently overwrites is the thing the prompt exists to prevent, and it
  // inherits the terminal, so the user answers it directly.
  const code = await deps.exec(updateArgv(sha, fetcher, env));
  if (code !== 0) for (const line of failureLines(code)) deps.err(line);
  return code;
}

/** Exit code of a process killed by SIGPIPE, by the 128+signal convention. */
export const SIGPIPE_EXIT = 141;

/**
 * What to say when the installer did not finish.
 *
 * ON STDERR, DELIBERATELY. The case that produced this is `suite update | head`
 * — the reader exits, the installer dies of SIGPIPE partway, and every word we
 * had written about what we were doing went into the pipe that just closed.
 * The user is left holding the announcement ("updating suite ... running the
 * installer from ...") with no ending, which reads exactly like success. Found
 * by noticing the deployed file did not contain the change that had just been
 * "installed".
 *
 * The install itself is safe — install.sh stages into `<lib>.incoming` and only
 * then swaps, so a death before the swap leaves the previous version whole
 * rather than half-written. That is worth saying out loud, because the useful
 * information is not "it failed" but "you are still on the old version and it
 * still works".
 */
export function failureLines(code: number): string[] {
  const lines: string[] = [];
  if (code === SIGPIPE_EXIT) {
    lines.push(
      `${CLI_NAME}: the installer was cut off because its output had nowhere to go — \`${CLI_NAME} update\` was piped into something that exited first (\`| head\`, \`| grep -q\`, a closed pager).`,
    );
    lines.push(`${CLI_NAME}: NOTHING WAS INSTALLED. Re-run it without the pipe.`);
  } else {
    lines.push(`${CLI_NAME}: the installer exited ${code} — the update did not complete.`);
  }
  lines.push(
    `${CLI_NAME}: your previous version is intact; install.sh stages the new one and swaps only at the end, so a failure here leaves the working install alone.`,
  );
  return lines;
}

export function liveUpdateDeps(): UpdateDeps {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    which: (name) => Bun.which(name),
    exec: async (argv) => {
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return proc.exited;
    },
    env: process.env,
  };
}
