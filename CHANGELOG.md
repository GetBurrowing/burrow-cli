# Changelog

Notable changes to the `burrow` CLI (named `suite` before 0.8.0). Newest first.

The version in `package.json` is the single source of truth — `burrow --version`,
the POSIX launcher and `install.sh`'s banner all read it. **Bump it in the same
PR as the change**, so that an installed CLI's version answers the only question
that matters in the field: is this one newer than what I had?

Minor for a new capability or a changed default; patch for a fix that changes no
behaviour anyone was relying on.

## 0.11.0

**The last `suite` names this CLI wrote are renamed, on each agent's next
start.** No dual support: writers write only the new names, and a folder
holding an old name beside its new one is refused, not merged.

| Before | From 0.11.0 |
| --- | --- |
| MCP server id `suite-channel` | `burrow-channel` |
| MCP server id `startup-suite` | `burrow` |
| `--dangerously-load-development-channels server:suite-channel` | `server:burrow-channel` |
| config key `suiteUrl` | `burrowUrl` |
| pane wrapper `suite-claude-continue` | `burrow-claude-continue` |
| channel entry `SUITE_*` env copies | not written; `BURROW_*` only |

- **Every Burrow tool's name changes with the server id.** Claude Code names
  tools `mcp__<server id>__<tool>`: `mcp__startup-suite__task_ack` is now
  `mcp__burrow__task_ack`, `mcp__suite-channel__suite_reply` is
  `mcp__burrow-channel__suite_reply`. Subagent `tools:` allowlists, settings
  allow-lists, hooks and `CLAUDE.md` text that spell the old prefix must move
  at the SAME restart as the agent. Claude Code hot-reloads subagent files and
  settings, so editing them while the old agent runs breaks its subagents.
- **The rename runs on a start only** (`src/legacy_names.ts`, the one module
  that spells the old names): `burrow claude` with no live session for the
  folder, and `burrow restore`. It renames the folder's local-scope entries in
  `~/.claude.json` (through `claude mcp remove` + `add-json`), its
  `.mcp.json`, the `enabledMcpjsonServers` / `disabledMcpjsonServers` lists in
  its `.claude/settings*.json`, its record's and the machine config's
  `suiteUrl` key, and moves the channel entry's `SUITE_*` env to `BURROW_*`.
  All in one start: renaming the local entries alone would unshadow a
  `.mcp.json` still enabled under the old ids and connect the agent twice.
- **Never under a running agent** (the 0.10.3 rule). An attach, `-p`, and
  `burrow claude new` beside a live session rename nothing; `new` is refused
  (exit 7) while the folder still has old names. Until then status, doctor and
  the attach read the old names read-only.
- **Refused, not merged:** an old name beside its new one anywhere above
  stops the start with exit 7, naming the file and both names. Every place is
  checked before any is changed, so nothing is renamed.
- **Restore** rewrites a roster entry recorded with `server:suite-channel` or
  `suite-claude-continue` before replaying it; replayed as recorded, the
  agent would come up without its channel. Adoption still skips a pre-0.11.0
  fallback shell.
- **The dev-channels dialog** is answered for `server:burrow-channel` only. A
  session launched with the old flag holds for a human.
- **`burrow` is no longer a legacy alias** that convergence removes; it is the
  tools id. A leftover `suite` alias is still removed. An old id left at
  local scope fails convergence as "renamed at the next start"; at user scope
  it is reported with the `claude mcp remove` command, never removed.
- **Other harnesses** rename the `suiteUrl` key in `burrow.json` (and the
  codex bridge in its folder record) at their own start, beside the 0.10.2
  file rename. Their own MCP ids (Codex's `-c mcp_servers.startup-suite`,
  hermes-suite-channel's `mcp_servers.startup-suite`, OpenClaw's channel id)
  are not renamed by this release.

## 0.10.3

**Fix: an attach no longer renames an agent root under its running agent.**
0.10.2 said "a root whose agent is running keeps its old names until that
agent's next start". That was false. On hive on 2026-10-20 a watchdog re-ran
`burrow deepseek` against oddjob's live session; the run renamed the root,
then attached, and the running `dsh` was left holding
`--patch .../.dsh/suite.patch.yml`, a path that no longer existed.

- **`deepseek`** renames only on a path that starts the agent: `--no-session`
  (the process that execs `dsh`, which is also what the tmux session runs),
  and the tmux path once it has decided to create a session (none, or a stale
  one). Attaching to a live session renames nothing. It also no longer
  rewrites `.dsh/burrow.patch.yml` on every attach; the start writes it.
  Before it knows which it will do, it reads an unmigrated root through the
  old names, read-only (`readablePath` in `src/agent_root_names.ts`).
- **`hermes` and `openclaw`** (no flag): their stamp renames, so while the
  agent's session is live and the root still holds old names, the run skips
  the stamp and only attaches, saying so. The next start (`--gateway-only`)
  renames. A root already renamed is stamped on attach as before. Their
  running gateways hold none of the five paths, so 0.10.2 broke nothing live
  here; the stated rule was still false.
- **Unchanged:** `--gateway-only` and the `codex` bridge rename, and both
  are starts. `burrow status`, `burrow update` and `burrow restore` rename
  nothing themselves (`restore` replays the recorded start, which does).
  **`--stamp-only` still renames whether or not the agent is running.** It is
  an explicit rewrite of the root, not an attach, and it does not look at
  sessions.

## 0.10.2

The last `suite` names in an agent root are now `burrow` names. There is no
dual read: the first 0.10.2 run in each root renames what is there.

| Before | From 0.10.2 |
| --- | --- |
| `suite.json` | `burrow.json` |
| `.suite-stamp.json` | `.burrow-stamp.json` |
| `.suite-state.json` | `.burrow-state.json` (still `0600`) |
| `.suite-codex/` | `.burrow-codex/` |
| `.dsh/suite.patch.yml` | `.dsh/burrow.patch.yml` |

- **One-shot rename, in place** (`src/agent_root_names.ts`). Old present and
  new absent: `rename(2)`, which keeps mode and owner. Both present: the verb
  refuses, names both paths, and renames nothing (every entry is checked
  before any moves). Already migrated: nothing happens.
- **Where it runs:** wherever a verb resolves the agent root, before it reads
  it. That means the stamp (`hermes`, `openclaw`, including `--stamp-only`),
  their `--gateway-only` relaunch, `deepseek` (its `--root`, a cwd that holds
  the old identity, and the default `~/agents/<name>`), and the `codex` bridge
  process. `burrow status` and `burrow update` never rename. ~~A root whose
  agent is running keeps its old names until that agent's next start.~~
  **False as shipped; see 0.10.3.** `deepseek`, `hermes` and `openclaw`
  renamed before attaching to a live session.
- **A stamp survives the rename.** The inputs digest covers harness, writer
  version, Burrow URL, runtime id, token ref and the verb's non-secret inputs.
  None of those names a file in the root, so a renamed root still passes the
  `--gateway-only` gate without a restamp.

## 0.10.1

The agent-host features from core task 01a10322, which shipped only on the
`task/01a10322-…-pane-status` branch (pinned by core's agent host at
`3f80728`, 0.8.0), are now on main.

- **`burrow pane-status --session NAME [--answer]`**: one look at an agent's
  Claude Code pane as JSON, for a supervisor with no terminal. It prints one
  document and writes it to `<state>/burrow/sessions/<session>.status.json`
  (0600, atomic). The states are `ready`, `dialog`, `needs_login`,
  `unknown_dialog`, `starting`, `stuck` and `gone`. Login screens are
  recognised and reported, never answered.
- **The API-key confirmation is answered for the agent's own
  `ANTHROPIC_API_KEY` only.** Any other key, or no key, reads `needs_login`.
- **Unattended launches skip Claude Code 2.1.295's onboarding.**
  `BURROW_UNATTENDED=1` (set by the agent host's unit) seeds
  `hasCompletedOnboarding` before launch. A launch record beside the session
  log carries the `stuck` and `auth_error` states.
- **`needs_login`** is reported for a key rejected at startup and for no key
  at all.
- Ported to 0.10: the status file and launch record resolve through
  `<state>/burrow` like the session log; the env name is `BURROW_UNATTENDED`
  (was `SUITE_UNATTENDED`); messages say `burrow`.

## 0.10.0

The `suite` command alias is removed. `burrow` is the only command.

- **install.sh renders one launcher, `burrow`.** It no longer writes
  `<bin>/suite`, no longer announces an existing `suite` as the install it
  replaces, and its report has no `suite (alias)` row. A `suite` an earlier
  install left behind is not deleted: remove it once nothing invokes it.
- **The launcher and `cli.ts` drop the alias plumbing**: `BURROW_INVOKED_AS`,
  the stderr notice (`suite: this command is now burrow; ...`) and
  `BURROW_NO_DEPRECATION` are gone. The launcher's bun-bootstrap messages say
  `burrow:` instead of `suite:`.
- **`package.json` has one bin entry, `burrow`.** `--help` no longer mentions
  the alias.
- Unchanged: the `SUITE_*` environment fallbacks, the one-shot state migration
  (which still rebinds units that name `suite` to `burrow`), and the `suite`
  MCP server and `suite-*` tmux session names.

## 0.9.0

Burrow rename B2: what 0.8.0 left under the old names moves, once, on the first
0.9 run, and the CLI's repo becomes `burrow-cli`. No running agent is stopped,
orphaned or duplicated by any of it.

- **One-shot state migration** (`src/migrate.ts`, run from `cli.ts` before
  dispatch; skipped for `--version`, `--help`, `update`, `pane-status` and every
  `--stamp-only`; stderr only). Everything now resolves under `<data>/burrow`,
  `<state>/burrow` (roster, session logs) and `<config>/burrow`. An entry no
  live process references is renamed (across filesystems: copied to
  `<target>.incoming`, renamed into place, source removed); a live one is copied
  and the original left byte-identical; a refused one gets a
  `MOVED-TO-BURROW.txt` breadcrumb, is recorded in `<state>/burrow/migration.json`,
  keeps resolving to its old path for that entry only, and is retried on each
  run. The config dir moves an allowlist (`config.json`, `state.json`,
  `watch.env`, `agents`, `credentials.json`) and leaves anything else as
  foreign. `watch.env`'s `SUITE_TELEMETRY_AUTH` becomes `BURROW_TELEMETRY_AUTH`
  at 0600. Plugin checkouts are renamed as they move:
  `claude-code-suite-channel` -> `burrow-channel-claude-code`, and the openclaw
  and hermes equivalents. A lock serialises concurrent first runs; once done,
  a run reads `migration.json` and nothing else. Old dirs are never deleted;
  `burrow doctor` lists them and what still uses them. `install.sh` puts the
  library at `<data>/burrow/cli`; the old `<data>/suite/cli` is retired, not
  moved, because the running watch daemon executes from it.
- **Recorded paths are rewritten**: `~/.claude.json` channel entries (through
  the claude CLI, read back, restored on a failed add), `openclaw.json`
  `plugins.load.paths`, `.dsh` patch files and Hermes `config.yaml`, each with
  a backup. A dev checkout's agent is listed, never written.
- **Units**: `burrow-watch` and `burrow-agents` (launchd
  `technology.milvenan.burrow-*`), `KillMode=process` in both. The migration
  stops the old unit before starting the new one, carries enablement across and
  retires the old file to `*.retired-by-burrow-<ts>`; it never stops a unit
  whose cgroup holds a tmux server or pane, and the supervised daemon never
  stops its own unit.
- **tmux sessions are `burrow-*`.** A live `suite-X` is still found, attached
  and restored by every verb; a stale one is recycled and comes back as
  `burrow-X`. An entry running a dev checkout keeps its recorded name.
- **The Claude Code plugin is pinned.** `CLAUDE_CODE_CHANNEL_REF` is
  `a77532e6623405c2eb9043d2d663a1e09a3e45f2` (burrow-channel-claude-code 0.4.1).
  Before, an existing checkout was never pulled, so a host stayed on the commit
  it first cloned. `burrow claude` now holds it at the pin: at the pin it runs
  no git at all (HEAD is read from the files); behind it, clean and unused, it
  fetches only when the pin is missing, `checkout --detach`es the pin, runs
  `bun install` and records the pin in `node_modules/.burrow-cli-deps-ref`. A
  dirty, diverged or in-use checkout is left exactly where it is, with a
  launch warning saying why, and the agent starts anyway. Never reset, never
  forced. `HERMES_CHANNEL_REF` moves to `36e3d5398d724be0fe55232a7df536454ca189c9`
  (burrow-channel-hermes v0.3.1). `OPENCLAW_CHANNEL_REF` stays at v0.8.0.
- **Tags install.** `BURROW_CLI_REF=v0.8.0` used to 404, because `install.sh`
  read every non-SHA as a branch. A SHA and a full `refs/heads/*` or
  `refs/tags/*` ref are fetched as given; a bare name is tried as a branch, then
  as a tag on a 404, so a branch still wins. A failed install names every URL it
  tried and what each answered. The ref is now validated in `install.sh` too.
- **The repo is `burrow-cli`.** Every fetch of this CLI's own files (the
  installer, the tarball, the commits API) tries `burrow-cli` first and
  `suite-cli` only on a 404, so it works before `gh repo rename` and after it
  without relying on GitHub's redirect. Any other failure stops rather than
  falling back. `BURROW_CLI_REPO` names one repo instead. The channel repos are
  cloned by their own names: `burrow-channel-claude-code`,
  `burrow-channel-openclaw`, `burrow-channel-hermes`. The units'
  `Documentation=` and the README install line point at `burrow-cli`.
- **The product is Burrow in the code, the README and the docs.** Comments,
  messages, test names and the bundled dsh plugin's tool description say
  Burrow. The old name stays only on the lines `test/product_name.test.ts`
  lists, each with its reason: changelog entries before this one, the license
  holder, the GitHub org literal, and a verbatim pre-0.9 unit file. The test
  fails on an unlisted line, on a listed line that is gone, and on the product
  called by both names. In the shipped files the old repo name stays where
  the fallback fetches it, in the README's compatibility note, and in the
  OpenClaw plugin's on-disk deps marker, which existing checkouts carry. The README's
  Compatibility section now describes the one-shot move and its breadcrumbs
  in place of the config-dir existence rule.

## 0.8.1

Ported from the 2026-09-08 dsh working tree (most of which already landed
separately); this is the part that did not.

- **dsh agents can post into a Suite space: the federation plugin registers a
  `suite_reply` tool.** The hosted Suite MCP surface has no tool that posts a
  message into a space — only reads, plus `dm_create`, which is humans-only —
  and Claude-side agents get their `suite_reply` from a separate local MCP
  bridge (a 2026-08-31 product decision keeps the dsh send path named
  `suite_reply`). This closes the gap over the websocket the plugin already
  holds. The contract is honest about what the channel can answer: core never
  replies to a `reply` push (`handle_in` returns `{:noreply, socket}` on both
  branches), so the tool sends, listens ~1.5s for a separate `error` event,
  and resolves ok only if none arrives — a refusal check, not a delivery
  receipt. When `space_send_message` lands on the hosted surface this should
  be deleted in favour of it.
- **Registration of the tool is non-fatal, and `tools` is an optional nested
  inject.** The plugin ships in every `burrow deepseek` install, and dsh builds
  without a mounted tools service must lose the send path, not the agent.
  Cordis holds a plugin INACTIVE until every entry in its top-level `inject`
  mounts, so `tools` is never listed there: it is resolved by a nested
  `ctx.inject(['tools'], ...)` inside apply. A build without the service keeps
  that nested fiber inactive and the plugin alive; a build with it registers
  the tool (`TOOL-REGISTERED` on stderr), and a throwing `register` is logged
  loudly (`TOOL-REGISTER-FAILED`) and never rethrown — federation carries on
  either way. The tool itself arrives through `@deepseek-ai/dsh-tools`
  (`defineTool`).
- **The `session/event` live tool trace.** `tool/call` lines with truncated
  arguments and `tool/result` lines carrying only byte sizes are written to
  stderr as they are recorded, so a `burrow deepseek` pane shows what the
  agent is doing between ATTENTION and REPLY instead of a burst of history
  afterwards. Registered on `ctx` so it needs no per-session re-attach; the
  whole trace body is wrapped so it can never disturb the turn it describes.
- **Queued dispatches show typing.** A message queued behind a running turn
  in the same space pushes a `typing` indicator, so an agent that is visibly
  working is distinguishable from one that dropped the message.
- **`burrow deepseek` records its launches for restore-on-boot.** The verb
  now carries `restore` deps exactly as `burrow claude` does: a successful
  tmux session create records the session with kind `deepseek` and the full
  tmux argv, so `suite restore` can relaunch dsh agents alongside recorded
  claude ones. Injected, so tests record nothing.
- **Tests:** suite_reply resolves ok when no error event arrives within the
  grace window and `ok:false` with the error detail when one does; non-fatal
  registration when the tools service is missing or `register` throws; the
  queued `typing` push; the trace's truncation, byte counting and
  crash-proofing; deepseek launch recording (created yes, attach no).
- **Rollback:** `SUITE_CLI_REF=<merge-commit-of-0.8.0> suite update`
  reinstalls 0.8.0. It does not touch credentials or connections.

## 0.8.0

The command is now `burrow`. Everything that worked under `suite` still works;
README, [Compatibility](README.md#compatibility), lists what kept its old name
and why.

- **Two launchers.** `install.sh` writes `burrow` and `suite` (two rendered
  files, no symlink). `suite` prints one stderr line,
  `suite: this command is now burrow; suite keeps working as an alias`, and
  otherwise behaves identically: stdout is byte-for-byte the same, because
  `--version`, `status --json` and `--stamp-only` are machine-read.
  `BURROW_NO_DEPRECATION=1` silences it. The installer announces an existing
  `suite 0.7.x` by that name and offers to replace it; its last line is
  `burrow init`.
- **`BURROW_*` environment variables, `SUITE_*` still read.** Every variable is
  resolved by one function (`src/env_names.ts`): `BURROW_X` when set and
  non-empty, else `SUITE_X` with one deprecation line on stderr per name. Both
  set: `BURROW_X` wins, silently. Values the CLI writes for other programs (the
  channel MCP entry, the launcher, the installer environment of `burrow update`)
  carry both names. `BURROW_*` is stripped from harness children like
  `SUITE_*`, so a `BURROW_TOKEN` never reaches one.
- **Config dir.** `~/.config/burrow` on a new host; an existing
  `~/.config/suite` keeps being used when there is no `~/.config/burrow`.
  Nothing is migrated, copied or deleted.
- **MCP registration converges** on the unchanged names `startup-suite` and
  `suite-channel`. Leftover user- or local-scope alias entries named `suite` or
  `burrow` are removed, one printed row each, naming the host they pointed at.
- **Messages, help and docs say `burrow` and Burrow.** Every hint and error
  prefix comes from one constant, `CLI_NAME` in `src/version.ts`. The package is
  `burrow-cli`. `--burrow-url` is accepted beside `--suite-url` (and wins).
- **Conventions.** `src/claude_md.ts` exports `BURROW_CONVENTIONS`;
  `SUITE_CONVENTIONS` is the same string, kept for core's agent-host, which
  imports it. A folder with neither conventions file gets
  `BURROW_CONVENTIONS.md`; an existing `SUITE_CONVENTIONS.md` keeps its name and
  is still the one refreshed.
- **A failed convergence step no longer stops a launch.** When the channel
  plugin checkout (clone, fast-forward, `bun install`) or the MCP alias
  convergence fails, `burrow claude` and `burrow restore` print a
  `burrow: WARNING: ... failed for <folder>; launching anyway.` block and start
  the agent. A missing token or a refused `claude mcp add` still stops it.
- **Channel pins** move to the tagged Burrow plugin releases:
  `OPENCLAW_CHANNEL_REF` is `ad307416839aaf266ce6fd941dbcc25446e0445c`
  (burrow-channel-openclaw v0.8.0) and `HERMES_CHANNEL_REF` is
  `f1399d77eba86f898d0d32de8c8baa0a783a72ec` (burrow-channel-hermes v0.3.0).
  The Claude Code plugin is not pinned; a fresh checkout clones its main
  (burrow-channel-claude-code 0.4.0, a5a981bc, at release time).
- **Unchanged on purpose:** the lib and data dirs (`~/.local/share/suite/`),
  the watchdog and restore unit names and launchd labels, the binary path the
  units run, the tmux session prefix `suite-`, and the repo names.

## 0.7.3

- **The GitHub org is no longer hard-coded.** Every repo URL the CLI builds
  (its installer and tarball in `install.sh` and `suite update`, the commits
  API lookup, the Claude Code plugin clone, the OpenClaw and Hermes channel
  clones, the SSH recovery hint, and the units' `Documentation=` lines) now
  comes from one place, `src/repo_source.ts`, plus one default line in
  `install.sh`. `SUITE_GITHUB_OWNER` overrides the org. It is read from the
  process environment only, never from a config file, and must be a GitHub
  owner name (1-39 letters, digits or hyphens, not starting with a hyphen).
  Anything else is refused by name before a URL is built. Unset or empty means
  the default.
- **The default stays `Startup-Suite`.** URLs under it keep working after the
  org rename through GitHub's redirects. Flipping the default is a one-line
  change to `DEFAULT_GITHUB_OWNER` plus `install.sh`'s default, in a later
  patch release at cutover, once the new org exists.
- **`suite update` passes the owner, as it already passes the ref.** It exports
  the same `SUITE_GITHUB_OWNER` it built the installer URL from into the
  installer's environment, so the installer and the tarball cannot come from
  two orgs, and it prints the resolved `owner/repo` on every update.
- **Channel pins bumped.** `OPENCLAW_CHANNEL_REF` is now
  `b220c8b1240dc337f48fe2f92967816f84344582` (openclaw-suite-channel v0.7.0,
  PR #31: underscore tool names first, dotted fallback), and
  `HERMES_CHANNEL_REF` is now `71041456d605e2d3341a214e5c09e924148f3558`
  (hermes-suite-channel v0.2.0, PR #6: overridable install repo). Both are the
  tip of their repo's main.
- **The SSH recovery hint names the checkout's own repo.** Through 0.7.2 an
  auth failure fetching the OpenClaw or Hermes channel checkout suggested
  pointing it at the Claude Code plugin's remote.
- **Rollback:** `SUITE_CLI_REF=0688c5d4b1748b90da208aaef7d99f6dfa3842ab suite update`
  reinstalls 0.7.2. It does not touch credentials or connections. A tag is not
  an install ref (`install.sh` reads every non-SHA ref as a branch), so the
  release identity of 0.7.3 is its merge commit on main plus
  `suite --version`.

## 0.7.2

- **dsh `usage_event` names the task and stage it belongs to.** The
  suite-federation plugin now sends top-level `task_id` (from the dispatch
  signal, falling back to `context.task.id`) and `metadata.stage_id` (the plan
  stage whose status is `running`). Core matches usage reports to dispatches
  on those two keys; without them every dsh agent's client-side token and turn
  figures were unattributable. A dispatch with no task (a plain mention) sends
  null for both, never an invented id.

## 0.7.1

- **The connection is per agent folder, not per machine.** Through 0.7.0,
  `suite init` saved ONE connection per machine, so `suite init` in a second
  agent folder silently re-pointed the first: the next `suite claude` there
  treated its own MCP entries as stale and rewrote them with the other agent's
  runtime, URL and token. Now `suite init` saves the connection for one folder
  (the working directory, or `--dir PATH`) under
  `~/.config/suite/agents/<key>.json` plus a 0600 `.credentials.json`, outside
  the folder. `suite init` in folder B cannot change folder A's bytes.
- **The legacy machine connection is assigned to no folder.** A 0.7.0
  `config.json` / `credentials.json` connection is still read and reported
  (`suite status` prints it as `legacy`), but it is never written, deleted or
  used to identify or wire a folder. **Re-run `suite init` (or
  `suite init --from-mcp-json`) in each agent folder after upgrading.** Until
  then, `suite claude` in a folder that has Claude entries and no record
  leaves the entries as they are, registers nothing and says so; in a folder
  with neither, it asks the init questions when it has a terminal.
- **Existing entries are repaired when the agent is next started, not by
  `init`.** `suite init --from-mcp-json` alone does not rewrite a folder's local
  Claude entries; `suite init` never runs `claude`. Once a folder has a record,
  the next `suite claude` there, or the next `suite restore` that starts that
  folder's agent, compares the entries with the record and rewrites the ones
  that differ. `suite restore` now does that before replaying each `claude`
  roster entry. It skips an agent whose session is already live, and does not
  rewire it.
- **`suite init --from-mcp-json`** adopts the folder's own `.mcp.json`, so no
  token passes through an argv, a shell or a terminal. It refuses, naming fields
  and never values, when the entries are missing, name different hosts, or carry
  different tokens.
- **`suite doctor` has an `agents` check.** It fails on any cross-wired agent
  folder on the machine, where the record, the local Claude entry and
  `.mcp.json` name different runtimes or hosts, and on any user-scope Suite
  entry. It names the folder and the runtime ids, reads `~/.claude.json`
  directly, never runs `claude mcp get/list`, and writes nothing. Its `install`
  check reads this folder's record.
- **`suite status` lists every agent folder** with its runtime and install,
  from the same inventory as `--json`, so both count the same agents. A folder
  wired only by its Claude entries is listed as `(unrecorded — run suite init)`.
- **An unwired `suite claude` names the folder** it could not connect, and
  where to run `suite init`; so do the `suite codex` and `suite deepseek`
  refusals.
  **`suite status --json [--dir PATH]`** prints one document,
  `contract_version` 1, with `connection`, `legacy_connection` and an `agents`
  row per agent (`session`, `kind`, `root`, `runtime_id`, `suite_url`, `state`,
  `channel`, `verdict`, `recorded`, `wiring`). No token value or token field
  appears, and no row takes its runtime id from the legacy connection. See the
  README's status contract.
- **`suite watch` telemetry events carry `runtime_id`** from the event's folder
  record, or null.

## 0.7.0

- **`suite codex`: a Codex agent in Suite, through `codex app-server`.** It
  reuses the saved install connection, or asks for it inline. When Codex is
  not logged in, it runs Codex's own `codex login --device-auth`, which needs
  no browser on the host. It gives Codex the install's MCP tools plus a
  `suite-channel` server with `suite_reply`, `suite_typing`,
  `suite_reply_chunk` and `suite_reply_with_media`, as `-c` overrides, so no
  config file is edited and no token is in an argv. Each Suite space maps to
  one persistent Codex thread, which is resumed after a restart. Approval
  requests follow `--approvals accept|decline` (default `accept`, the parity
  of `suite claude`'s `--dangerously-skip-permissions`). It runs under the same
  tmux, restore and watchdog supervision as `suite claude`. `CODEX_HOME`
  defaults to `<root>/.codex`.
- **`suite restore` and `suite status` know the `codex` kind**, and adoption
  recognises a running `suite codex` bridge.

## 0.6.1

- **Agents come back with nobody at the keyboard.** Claude Code shows a
  full-screen "Loading development channels" warning on every launch with
  `--dangerously-load-development-channels`, and in a new folder it first asks
  whether the folder is trusted. Until someone answered, a restarted or
  rebooted agent sat there alive and silent. `suite claude` and `suite restore`
  now watch each session they start for up to 60 seconds and answer those
  dialogs — plus the bypass-permissions acceptance and the "New MCP server
  found" prompt (answered "Continue without", never an approval). `suite watch`
  answers one still on screen in a session it owns, as a backstop.
- **Only screens known word for word.** A dialog is answered only when its
  whole text matches the screen captured from Claude Code 2.1.288 (kept as test
  fixtures), with the folder it names being the folder the agent was launched
  in and the channel being `server:suite-channel` alone. The key depends on
  where the cursor is: two of these dialogs default to "No, exit". A reworded
  or unknown dialog gets no keys and one log line saying so.
- **Every key is logged** to `~/.local/state/suite/sessions/<session>.log`, and
  each tmux call targets the session by exact name (`=NAME:`), never a prefix.

## 0.6.0

- **`suite init` is harness-neutral.** It connects the machine to a Suite
  install and does nothing else: it checks `bun` and `tmux`, saves the URL,
  runtime id and token, and installs the watchdog. It no longer clones the
  Claude channel plugin, runs `claude mcp add` or writes `CLAUDE.md`. Before
  this, on a machine without Claude Code (a fresh Mac, or a DeepSeek-only box),
  init died at `claude mcp add` with `ENOENT: claude`.
- **`suite claude` does its own wiring.** Before each launch it clones the
  channel plugin if it is absent, writes `CLAUDE.md` if there is none, and
  registers each MCP entry that is missing or no longer matches the saved
  connection. It uses the saved connection and does not ask for credentials
  again. A folder that is already wired runs no `git`, `bun` or `claude mcp`.
  An existing plugin checkout is no longer pulled. Re-running init used to
  update it; update it with `git -C ~/.local/share/suite/claude-code-suite-channel pull`.
- **No chicken-and-egg.** `suite claude`, or `suite deepseek` from a terminal,
  on a machine with no saved connection now asks the init questions itself
  (URL, runtime id, token) and saves the answers. It no longer says "run suite
  init first". Off a terminal, `suite claude` warns and starts Claude without
  Suite wiring, which is what it did before. `suite deepseek` refuses as before.
- **The token is saved** in `~/.config/suite/credentials.json`, mode 600, next
  to `config.json`, so any harness verb can reuse it. Before this the only copy
  was inside Claude's MCP entries. A machine set up by 0.5.x is asked for its
  token once, and only if an entry has to be rewritten. With `--token-from-env
  VAR`, only the name is saved (config `tokenEnv`).
- **`suite deepseek` finds the token `suite init` saved.** Before this it read
  `state.json`, which init never wrote, so it always failed with "no runtime
  token found" unless the agent root had its own state file.
- **`suite doctor` reports two halves.** The install connection (`install`,
  `tmux`) comes first, then the claude harness. A missing, moved or unreadable
  Claude entry now points at `suite claude`. A rejected credential still points
  at `suite init`.
- `suite init --checkout` is accepted and ignored, with a note saying so.
- `suite hermes` and `suite openclaw` are unchanged. They take their identity
  from flags and the agent root's `suite.json`, and never depended on init.

## 0.5.1

- **`suite deepseek` works from the agent's folder.** `cd ~/agents/oddjob &&
  suite deepseek` now uses that folder's own `suite.json` and
  `.suite-state.json`, as `--root` does. Before this it fell back to the machine
  config and said to run `suite init`. When the agent's session is live the
  command attaches to it, and when the session is stale it is recycled, as
  `suite claude` does. `--root` still takes precedence. A parent directory of
  an agent root is not treated as that agent.
- **`suite deepseek` passes the agent's `env` block to the harness.**
  The `env` in `<root>/.suite-state.json` (`OPENROUTER_API_KEY`, `DSH_MODEL`,
  `DSH_PERMISSION_MODE`, ...) was never read. dsh therefore started without its
  model key, connected, and failed every turn with `MISSING_CREDENTIAL`. Those
  values now go into the environment only, and the argv guard covers them. The
  agent's values override both the inherited environment and the defaults. The
  patch declares the model that `DSH_MODEL` selects, so choosing a model other
  than the default no longer fails with `UNKNOWN_MODEL`. The command now warns
  when the OpenRouter route has no key.

## 0.5.0

- **`suite init` registers the MCP entries per agent directory, not per
  machine.** Both `suite-channel` and `startup-suite` are now added at local
  scope, from the agent directory. They used to be added at user scope, which
  is one entry shared by every Claude on the machine, so installing a second
  agent replaced the first agent's entries with the second one's Suite and
  runtime. On a real host that meant an agent's next restart would have
  federated into the other install as the other runtime. Nothing is written
  into the agent directory; the entries live in the mode-600 `~/.claude.json`
  under the directory's key. `init` never removes or rewrites a user-scope
  entry, because another agent may still depend on it. It warns when that entry
  names a different runtime, and this directory's own entry takes precedence
  here. A re-run replaces only this directory's entries. Agents that relied on
  the old user-scope entry keep working until you run `suite init` in their
  directory.

- **A new agent's first `suite claude` stays up again.** `suite claude` injects
  `--continue`, and in a directory with no conversation Claude exits 1 with "No
  conversation found to continue". The earlier retry (PR #21) ran from `suite
  claude` when the session was dead 1.5 s after launch, but Claude's development-channels warning
  (and, in a new directory, the workspace-trust prompt) keeps the process alive
  until it is answered. So the retry never fired, `suite claude` printed
  "started …", and the agent exited as soon as the dialog was accepted. The
  fallback now runs in the pane itself: `/bin/sh -c` runs claude with
  `--continue`, and if that exits non-zero it `exec`s claude without it. The
  relaunch shows the development-channels warning again, so a new agent asks
  for it twice. The
  argv still reaches claude as positional parameters and is never parsed as
  shell text. It does not retry after exit 0, after death by signal, or when the
  first run lasted 5 minutes or more, because a continued conversation that
  exits non-zero after that long has crashed, and restarting it fresh would drop
  the conversation without saying so. The restore roster records the wrapped
  command, and `suite restore --adopt` adopts the claude process under the
  shell, not the shell.

## 0.4.0

- **`suite hermes` and `suite openclaw`: stamp a Hermes or OpenClaw agent root
  Suite-ready, then run its gateway in a persistent tmux session.** Each agent's
  harness state lives under its root, never in `~/.hermes` or `~/.openclaw`,
  and neither verb installs, starts or restarts a daemon. The runtime token is
  accepted only by reference (`--token-ref file:<path>` or
  `--token-ref keychain:<item> --keychain-service <svc>`); a literal is refused.
- **`suite hermes` stamps a lean toolset for the Suite platform by default.**
  It sets `platform_toolsets.startup_suite: [hermes-webhook]` (web, vision and
  clarify, plus every enabled MCP server, so the Suite bridge stays) and no
  other toolset key. The reasons: a channel agent's capabilities come through
  the Suite MCP bundle, shell and file tools widen what untrusted chat can
  reach, and Hermes's own default makes the first prompt 16,633 tokens, which
  a 16K-context model cannot answer. `--full-toolset` opts out, removing the
  key only when it holds exactly that lean list. An operator's own value is
  never overwritten.
- **Stamp results report what happened, not what was planned.** Each action
  carries `applied`; a failed run lists the writes it never reached as
  `applied: false`, and a harness install that ran before a refusal is still
  listed. A run that fails after its first write records `fail` in
  `.suite-stamp.json`, so `suite status` and `--gateway-only` never act on an
  older `pass`.
- **A signalled gateway wrapper takes its gateway down.** The session exec
  forwards SIGTERM and SIGHUP (and SIGINT when no terminal delivered it) to the
  child and waits for it, instead of leaving it orphaned.
- **`--stamp-only` is a stable machine contract** for callers such as core's
  installer `setup channel` step: one JSON document on stdout
  (`contract_version: 1`, additive changes only), and exit codes 0 ok, 1 failed,
  2 refused, 3 blocked on a human. The README's "Stamp contract" section is the
  reference, and a test keeps it in step with what the code emits.
- **`suite status` lists stamped agents** with kind, root, session state and the
  last stamp verdict. A gateway that died takes its tmux session with it, so a
  recorded agent that is not running reads `stale`, not absent. Sessions of
  other kinds are now checked for their own process (`dsh`, `hermes`,
  `openclaw-gateway`), so they are no longer reported as a dead Claude.
- **The restore roster records `hermes` and `openclaw` agents**, and
  `suite restore --adopt` recognises their gateway sessions.

## 0.3.0

- **`suite init` no longer leaves an agent without the conventions just because
  the repo ships its own `CLAUDE.md`.** That filename carries two different
  documents — an agent's brief and a project's codebase guide — and `exists`
  cannot tell them apart, so in most mature repos `init` skipped, printed
  `present, left alone`, and the agent received none of the conventions with
  nothing saying so. An existing `CLAUDE.md` is still **never** written to.
  Instead the conventions go to `SUITE_CONVENTIONS.md`, a file the CLI owns
  outright and rewrites on every run, and `init` names what the existing file is
  missing plus the one line (`@SUITE_CONVENTIONS.md`) that loads it. A
  `CLAUDE.md` that already states the conventions gets no second file.

## 0.2.0

- **`suite init` seeds a starting `CLAUDE.md`** for new Suite agents — how a
  runtime is expected to behave on the platform, distilled from the briefs
  already in use. An existing file is never overwritten; a re-run reports
  `present, left alone`. The template is static and carries no identifiers.
- **Sessions are created with tmux mouse mode on**, scoped to the session and
  never `-g`. Without it, tmux turns a wheel event inside a full-screen app into
  arrow keys, so scrolling an agent walks its input history instead of its
  scrollback. New sessions only — reattaching never re-configures a session you
  are already working in. Note mouse mode also routes click-drag to tmux's
  selection, so a native selection needs the terminal's override modifier
  (Option on macOS).
- `--session` is wired through, so the flag the README documents exists.

## 0.1.0

First tagged version: `init`, `claude`, `doctor`, `status`, `update`, the POSIX
launcher and `install.sh`.
