/**
 * `suite deepseek` — the pure parts.
 *
 * Every assertion here corresponds to something that actually went wrong while
 * bringing the first agent up, because each of those failures was silent or
 * misleading at the point it happened:
 *
 *   - `/socket` answers a 302 that surfaces as an opaque websocket error
 *   - a `!!js` expression in a plugin `name:` throws `name.startsWith is not a
 *     function`, because that field is read before expressions are evaluated
 *   - the one-shot headless runner tears the agent factory down when its task
 *     ends, and a plugin holding the event loop open keeps the process alive
 *     around the corpse
 *
 * A regression in any of them costs an hour of confused debugging, so they are
 * pinned as text rather than trusted to a comment.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  burrowEnvNameForHeader,
  agentNameFromRuntimeId,
  sessionNameForAgent,
  envNameForHeader,
  libDirCandidates,
  mcpUrl,
  selfArgv,
  parseDeepseekOptions,
  renderPatch,
  publicEnv,
  runtimeWsUrl,
  secretEnv,
} from "../src/commands/deepseek.ts";
import { emptyConfig } from "../src/config.ts";
import { createStore } from "../src/secrets.ts";

describe("runtimeWsUrl", () => {
  test("targets the runtime endpoint, not the LiveView socket", () => {
    expect(runtimeWsUrl("https://suite.example.invalid")).toBe("wss://suite.example.invalid/runtime/ws");
  });

  test("downgrades the scheme for a plaintext deployment", () => {
    expect(runtimeWsUrl("http://localhost:4000")).toBe("ws://localhost:4000/runtime/ws");
  });

  test("a trailing slash does not produce a doubled path", () => {
    expect(runtimeWsUrl("https://suite.example.invalid/")).toBe("wss://suite.example.invalid/runtime/ws");
  });
});

describe("parseDeepseekOptions", () => {
  test("--root is ours and does not reach dsh", () => {
    const { root, rest } = parseDeepseekOptions(["--root", "/tmp/agent", "--verbose"]);
    expect(root).toBe("/tmp/agent");
    expect(rest).toEqual(["--verbose"]);
  });

  test("after `--`, --root belongs to dsh", () => {
    const { root, rest } = parseDeepseekOptions(["--", "--root", "/tmp/agent"]);
    expect(root).toBeUndefined();
    expect(rest).toEqual(["--root", "/tmp/agent"]);
  });

  test("passthrough is otherwise total and ordered", () => {
    const { rest } = parseDeepseekOptions(["a", "--b", "c d", "$HOME"]);
    expect(rest).toEqual(["a", "--b", "c d", "$HOME"]);
  });
});

describe("agentNameFromRuntimeId", () => {
  test("drops the transport suffix so the directory is named for the agent", () => {
    expect(agentNameFromRuntimeId("oddjob-dsh")).toBe("oddjob");
  });

  test("keeps anything else verbatim rather than guessing", () => {
    expect(agentNameFromRuntimeId("ryan-home-openclaw")).toBe("ryan-home-openclaw");
    expect(agentNameFromRuntimeId("dsh-runner")).toBe("dsh-runner");
  });
});

describe("sessionNameForAgent", () => {
  test("names the session for the agent, not the working directory", () => {
    // Unlike `suite claude`, which keys on cwd. A dsh agent is one identity
    // owning one root — two shells asking for `oddjob` must reach the SAME
    // session, and a cwd-derived name would silently give them two.
    expect(sessionNameForAgent("oddjob")).toBe("burrow-oddjob");
  });

  test("is stable regardless of where it is invoked from", () => {
    expect(sessionNameForAgent("oddjob")).toBe(sessionNameForAgent("oddjob"));
  });

  test("sanitises anything tmux would choke on", () => {
    expect(sessionNameForAgent("Odd Job.v2")).toBe("burrow-odd-job-v2");
    expect(sessionNameForAgent("--weird--")).toBe("burrow-weird");
  });

  test("two different agents never collide", () => {
    expect(sessionNameForAgent("oddjob")).not.toBe(sessionNameForAgent("oddjob2"));
  });
});

describe("parseDeepseekOptions --no-session", () => {
  test("is ours and does not reach dsh", () => {
    const { noSession, rest } = parseDeepseekOptions(["--no-session", "--verbose"]);
    expect(noSession).toBe(true);
    expect(rest).toEqual(["--verbose"]);
  });

  test("defaults to false, so the session is the normal path", () => {
    expect(parseDeepseekOptions([]).noSession).toBe(false);
  });

  test("after `--` it belongs to dsh", () => {
    const { noSession, rest } = parseDeepseekOptions(["--", "--no-session"]);
    expect(noSession).toBe(false);
    expect(rest).toEqual(["--no-session"]);
  });
});

describe("envNameForHeader", () => {
  test("normalises a header name into something a shell can carry", () => {
    expect(envNameForHeader("X-Example-Id")).toBe("SUITE_HEADER_X_EXAMPLE_ID");
  });

  test("collapses runs of punctuation rather than emitting empty segments", () => {
    expect(envNameForHeader("x--weird..name")).toBe("SUITE_HEADER_X_WEIRD_NAME");
  });

  test("two different header names never collide on one variable", () => {
    expect(envNameForHeader("A-B")).not.toBe(envNameForHeader("A-C"));
  });
});

describe("renderPatch", () => {
  const patch = renderPatch("/opt/harness/plugins/suite-federation/index.js", ["X-Example-Id"]);

  test("names the plugin by a literal path — dsh reads `name:` before !!js", () => {
    expect(patch).toContain("name: /opt/harness/plugins/suite-federation/index.js");
    expect(patch).not.toContain("name: !!js");
  });

  test("disables the one-shot runner, which would tear the agent tree down", () => {
    expect(patch).toContain("- id: headless-runner");
    expect(patch).toContain("disabled: true");
  });

  test("declares one MCP server per entry, not a servers map", () => {
    expect(patch).toContain("serverName: burrow\n");
    expect(patch).not.toContain("startup-suite");
    expect(patch).not.toContain("servers:");
  });

  test("carries each operator header through the environment, by name", () => {
    expect(patch).toContain(
      "X-Example-Id: !!js process.env[\"BURROW_HEADER_X_EXAMPLE_ID\"] || process.env[\"SUITE_HEADER_X_EXAMPLE_ID\"] || ''",
    );
  });

  test("a deployment with no extra headers still renders a valid block", () => {
    const bare = renderPatch("/opt/p/index.js", []);
    expect(bare).toContain("Authorization: !!js");
    expect(bare).not.toContain("SUITE_HEADER_");
  });

  test("the generated patch is parseable YAML", () => {
    // The guard that was missing: an unquoted backtick template is valid
    // JavaScript and invalid YAML, and dsh only says so at boot, inside a
    // reconnect loop, after the install has already succeeded.
    const doc = parse(patch) as unknown[];
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBeGreaterThan(2);
  });

  test("a patch with no operator headers is also parseable", () => {
    expect(Array.isArray(parse(renderPatch("/opt/p/index.js", [])))).toBe(true);
  });

  test("declares the provider route, not just the default model name", () => {
    // Naming a provider as the agent default without declaring its pi-ai route
    // fails at the first turn with NO_ADAPTER — long after the socket has
    // connected and every status says healthy.
    expect(patch).toContain("- id: llm-pi-ai");
    expect(patch).toContain("baseURL: https://openrouter.ai/api/v1");
    const doc = parse(patch) as Array<Record<string, unknown>>;
    const routes = doc.find((entry) => entry?.id === "llm-pi-ai");
    const defaults = doc.find((entry) => entry?.id === "agent-default-model");
    expect(routes).toBeDefined();
    expect(defaults).toBeDefined();
  });

  test("declares the model from the same expression that selects it", () => {
    // UNKNOWN_MODEL is the sibling of NO_ADAPTER: both come from two places
    // having to agree about one fact. The route's declared model and the
    // agent's selected model must be the SAME expression, or setting
    // DSH_MODEL (or editing one default) selects a model the route has never
    // declared. Comparing the two sides catches an edit to either; asserting
    // one literal line catches only an edit to that line.
    const doc = parse(patch) as Array<Record<string, any>>;
    const route = doc.find((e) => e?.id === "llm-pi-ai");
    const chosen = doc.find((e) => e?.id === "agent-default-model");
    const declared = route?.config?.providers?.openrouter?.models?.[0]?.id;
    expect(declared).toBeDefined();
    expect(String(declared)).toBe(String(chosen?.config?.model));
  });

  test("no secret value can reach the patch — only variable names", () => {
    expect(patch).not.toContain("Bearer sk-");
    expect(patch).toContain("${process.env.BURROW_RUNTIME_TOKEN || process.env.SUITE_RUNTIME_TOKEN}");
  });
});

describe("environment split", () => {
  const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid", runtimeId: "oddjob-dsh", headerNames: ["X-Example-Id"] };

  test("the public env carries no credential", () => {
    const env = publicEnv(config, "/home/u/agents/oddjob", {} as NodeJS.ProcessEnv);
    expect(Object.values(env).join(" ")).not.toContain("s3cret");
    expect(env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
    expect(env.DSH_HOME).toBe("/home/u/agents/oddjob/.dsh");
  });

  test("the secret env carries the one token and each header value", () => {
    const store = createStore({ token: "s3cret", headers: { "X-Example-Id": "hv" } });
    const env = secretEnv(config, store);
    expect(env.SUITE_RUNTIME_TOKEN).toBe("s3cret");
    expect(env.SUITE_HEADER_X_EXAMPLE_ID).toBe("hv");
  });

  test("a header named in config but absent from the store is omitted, not blank", () => {
    const store = createStore({ token: "s3cret", headers: {} });
    expect(secretEnv(config, store)).not.toHaveProperty("SUITE_HEADER_X_EXAMPLE_ID");
    expect(secretEnv(config, store)).not.toHaveProperty("BURROW_HEADER_X_EXAMPLE_ID");
  });

  test("the child env carries BOTH generations of every name, one value per pair", () => {
    const store = createStore({ token: "s3cret", headers: { "X-Example-Id": "hv" } });
    const env = { ...publicEnv(config, "/home/u/agents/oddjob", {} as NodeJS.ProcessEnv), ...secretEnv(config, store) };
    for (const suffix of ["WS_URL", "MCP_URL", "RUNTIME_ID", "RUNTIME_TOKEN", "HEADER_X_EXAMPLE_ID"]) {
      expect(env[`BURROW_${suffix}`]).toBeDefined();
      expect(env[`BURROW_${suffix}`]).toBe(env[`SUITE_${suffix}`] as string);
    }
    expect(env.BURROW_RUNTIME_ID).toBe("oddjob-dsh");
    expect(burrowEnvNameForHeader("X-Example-Id")).toBe("BURROW_HEADER_X_EXAMPLE_ID");
  });

  test("a stale BURROW_* inherited from the parent is overwritten in the child, as runDeepseek composes it", () => {
    // runDeepseek spreads process.env first, then publicEnv and secretEnv.
    const store = createStore({ token: "s3cret", headers: {} });
    const parent = { BURROW_RUNTIME_ID: "someone-else", BURROW_RUNTIME_TOKEN: "stale", BURROW_WS_URL: "wss://old.example.invalid" };
    const child = { ...parent, ...publicEnv(config, "/r", {} as NodeJS.ProcessEnv), ...secretEnv(config, store) };
    expect(child.BURROW_RUNTIME_ID).toBe("oddjob-dsh");
    expect(child.BURROW_RUNTIME_TOKEN).toBe("s3cret");
    expect(child.BURROW_WS_URL).not.toContain("old.example.invalid");
  });
});

describe("the rendered patch reads BURROW_* first, SUITE_* as the fallback", () => {
  const patch = renderPatch("/opt/p/index.js", ["X-Example-Id"]);
  /** The `!!js` expression on the line for `key:` under the federation/mcp blocks, evaluated against `env`. */
  function evalLine(key: string, env: Record<string, string>): unknown {
    const line = patch.split("\n").find((l) => l.trim().startsWith(`${key}: !!js `) && l.includes("process.env")) ?? "";
    expect(line).not.toBe("");
    let expr = line.slice(line.indexOf("!!js ") + 5).trim();
    if (expr.startsWith("'") && expr.endsWith("'")) expr = expr.slice(1, -1);
    return new Function("process", `return ${expr};`)({ env });
  }
  const cases: Array<[string, string]> = [
    ["runtimeId", "RUNTIME_ID"],
    ["token", "RUNTIME_TOKEN"],
    ["X-Example-Id", "HEADER_X_EXAMPLE_ID"],
  ];
  for (const [key, suffix] of cases) {
    test(`${key}: BURROW wins, SUITE alone still works`, () => {
      expect(evalLine(key, { [`BURROW_${suffix}`]: "new", [`SUITE_${suffix}`]: "old" })).toBe("new");
      expect(evalLine(key, { [`SUITE_${suffix}`]: "old" })).toBe("old");
    });
  }
  test("Authorization: the bearer is BURROW_RUNTIME_TOKEN first", () => {
    expect(evalLine("Authorization", { BURROW_RUNTIME_TOKEN: "new", SUITE_RUNTIME_TOKEN: "old" })).toBe("Bearer new");
    expect(evalLine("Authorization", { SUITE_RUNTIME_TOKEN: "old" })).toBe("Bearer old");
  });
});

describe("mcpUrl", () => {
  test("an explicit endpoint wins, because ours is a separate host", () => {
    const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid" };
    expect(mcpUrl(config, { SUITE_MCP_URL: "https://mcp.example.invalid/mcp" } as NodeJS.ProcessEnv)).toBe(
      "https://mcp.example.invalid/mcp",
    );
  });

  test("otherwise it is derived from the Burrow URL", () => {
    const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid/" };
    expect(mcpUrl(config, {} as NodeJS.ProcessEnv)).toBe("https://suite.example.invalid/mcp");
  });

  test("BURROW_MCP_URL is read first and wins over SUITE_MCP_URL", () => {
    const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid" };
    const env = { BURROW_MCP_URL: "https://new.example.invalid/mcp", SUITE_MCP_URL: "https://old.example.invalid/mcp" };
    expect(mcpUrl(config, env as NodeJS.ProcessEnv)).toBe("https://new.example.invalid/mcp");
  });
});

describe("the lib dir", () => {
  test("BURROW_LIB_DIR is read first, SUITE_LIB_DIR is the fallback", () => {
    expect(libDirCandidates({ BURROW_LIB_DIR: "/opt/new", SUITE_LIB_DIR: "/opt/old" } as NodeJS.ProcessEnv)[0]).toBe("/opt/new");
    expect(libDirCandidates({ SUITE_LIB_DIR: "/opt/old" } as NodeJS.ProcessEnv)[0]).toBe("/opt/old");
    expect(selfArgv({ BURROW_LIB_DIR: "/opt/new" } as NodeJS.ProcessEnv)[1]).toBe("/opt/new/src/cli.ts");
  });
});
