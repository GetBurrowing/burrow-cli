#!/usr/bin/env bun
/**
 * A `claude` stub whose `mcp add -s local` REALLY WRITES `~/.claude.json`.
 *
 * The plain shell stub (test/clean-env DEFAULT_STUBS.claude) logs `mcp add` and
 * writes nothing, so a test built on it can count adds but can never see the
 * NEXT launch read back what the last one wrote. Alternating launches across
 * two folders — what `suite restore` does at boot — is exactly the case where
 * that read-back matters. This stub closes the loop, at local AND user scope:
 *
 *   claude mcp add NAME -s local|user [-e K=V ...] -- CMD ARGS...        stdio entry
 *   claude mcp add NAME -s local|user (-t|--transport) http URL [-H "K: V" ...]
 *   claude mcp add-json NAME JSON -s local|user                          any entry, stored as given
 *   claude mcp remove NAME -s local|user
 *   claude mcp list        this folder's effective entries, "✔ Connected": local, then unshadowed user
 *   claude mcp --help      the subcommand list; omits add-json when STUB_NO_ADD_JSON=1, as an
 *                          older claude does (migrate.ts then falls back to `mcp add`)
 *
 * Local entries land in `projects[<cwd>].mcpServers` of `$CLAUDE_CONFIG_DIR/.claude.json`
 * (else `$HOME/.claude.json`), user entries in its top-level `mcpServers`, mode
 * 0600 — the shapes Claude Code 2.1.281 writes (measured; see MCP_SCOPE in
 * src/commands/init.ts). An add for a name already present IN THAT SCOPE fails
 * with "already exists", exit 1, as the real CLI does; a remove of an absent
 * name fails with "No MCP server found". A scope other than local/user fails.
 * Every invocation's argv is appended, tab-separated, to $STUB_LOG.
 *
 * Named apart from the 01a0d6b9 branch's test/fixtures/stub_claude_mcp.ts so
 * the two never collide as add/add.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Entry = Record<string, unknown>;
interface ClaudeJson {
  projects?: Record<string, { mcpServers?: Record<string, Entry> }>;
  mcpServers?: Record<string, Entry>;
  [k: string]: unknown;
}

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${["claude", ...argv].join("\t")}\n`);

const home = process.env.HOME ?? "";
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir !== undefined && dir !== "" ? resolve(dir, ".claude.json") : resolve(home, ".claude.json");
const cwd = process.cwd();

function load(): ClaudeJson {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as ClaudeJson;
}

function save(data: ClaudeJson): void {
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function servers(data: ClaudeJson, scope = "local"): Record<string, Entry> {
  if (scope === "user") {
    data.mcpServers ??= {};
    return data.mcpServers;
  }
  if (scope !== "local") fail(`stub_claude_local_scope: only -s local|user is modelled, got ${scope}`);
  data.projects ??= {};
  data.projects[cwd] ??= {};
  const project = data.projects[cwd] as { mcpServers?: Record<string, Entry> };
  project.mcpServers ??= {};
  return project.mcpServers;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (argv[0] !== "mcp") process.exit(0);

const noAddJson = process.env.STUB_NO_ADD_JSON === "1";

if (argv[1] === "--help" || argv[1] === "-h" || argv[1] === undefined) {
  const commands = ["add [options] <name> <commandOrUrl> [args...]", ...(noAddJson ? [] : ["add-json [options] <name> <json>"]), "list", "remove [options] <name>"];
  process.stdout.write(`Usage: claude mcp [options] [command]\n\nCommands:\n${commands.map((c) => `  ${c}`).join("\n")}\n`);
  process.exit(0);
}

/** `-s|--scope VALUE` anywhere in `args`, removed; "local" when absent. */
function takeScope(args: string[]): string {
  const at = args.findIndex((a) => a === "-s" || a === "--scope");
  if (at < 0) return "local";
  const [, value] = args.splice(at, 2);
  return value ?? "local";
}

if (argv[1] === "add-json") {
  if (noAddJson) fail("error: unknown command 'add-json'");
  const rest = argv.slice(2);
  const scope = takeScope(rest);
  const [name, json] = rest;
  if (name === undefined || json === undefined) fail("add-json: need <name> <json>");
  let entry: Entry;
  try {
    entry = JSON.parse(json) as Entry;
  } catch {
    fail("add-json: invalid JSON");
  }
  const data = load();
  const map = servers(data, scope);
  if (name in map) fail(`MCP server ${name} already exists in ${scope} config`);
  map[name] = entry;
  save(data);
  process.stdout.write(`Added ${String(entry.type ?? "stdio")} MCP server ${name} to ${scope} config\n`);
  process.exit(0);
}

if (argv[1] === "list") {
  const data = load();
  const local = Object.keys(data.projects?.[cwd]?.mcpServers ?? {});
  const user = Object.keys(data.mcpServers ?? {}).filter((n) => !local.includes(n));
  for (const name of [...local, ...user]) {
    process.stdout.write(`${name}: stub - ✔ Connected\n`);
  }
  process.exit(0);
}

if (argv[1] === "remove") {
  const name = argv[2] ?? fail("remove: no name");
  const at = argv.indexOf("-s") >= 0 ? argv.indexOf("-s") : argv.indexOf("--scope");
  const scope = at >= 0 ? (argv[at + 1] ?? "local") : "local";
  const data = load();
  const map = servers(data, scope);
  if (!(name in map)) fail(`No MCP server found with name: ${name}`);
  delete map[name];
  save(data);
  process.exit(0);
}

if (argv[1] === "add") {
  const rest = argv.slice(2);
  const name = rest.shift() ?? fail("add: no name");
  let scope = "local";
  let transport: string | null = null;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let command: string[] | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") {
      command = rest.slice(i + 1);
      break;
    }
    const next = rest[i + 1];
    if ((a === "-s" || a === "--scope") && next !== undefined) {
      scope = next;
      i++;
    } else if ((a === "-t" || a === "--transport") && next !== undefined) {
      transport = next;
      i++;
    } else if ((a === "-e" || a === "--env") && next !== undefined) {
      const eq = next.indexOf("=");
      env[next.slice(0, eq)] = next.slice(eq + 1);
      i++;
    } else if ((a === "-H" || a === "--header") && next !== undefined) {
      const colon = next.indexOf(":");
      headers[next.slice(0, colon).trim()] = next.slice(colon + 1).trim();
      i++;
    } else {
      positional.push(a);
    }
  }
  const data = load();
  const map = servers(data, scope);
  if (name in map) fail(`MCP server ${name} already exists in ${scope} config`);
  if (transport === "http") {
    map[name] = { type: "http", url: positional[0] ?? "", headers };
  } else {
    const [cmd, ...args] = command ?? positional;
    map[name] = { type: "stdio", command: cmd ?? "", args, env };
  }
  save(data);
  process.stdout.write(`Added ${transport === "http" ? "HTTP" : "stdio"} MCP server ${name} to ${scope} config\n`);
  process.exit(0);
}

process.exit(0);
